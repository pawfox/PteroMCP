// Extra tools added by this fork on top of @zefarie/pterodactyl-mcp 0.1.0.
// Kept in a separate module so the upstream bundle stays easy to diff and update.
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix } from "node:path";
import { z } from "zod/v4";

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const SERVER_ID = z
  .string()
  .min(1)
  .describe("Short server identifier string from list_servers field 'identifier' (e.g., 'a1b2c3d4')");

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error) {
  const body =
    error && typeof error === "object" && "code" in error && "status" in error
      ? { error: error.code, message: error.message, status: error.status }
      : { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

function tool(server, name, description, shape, annotations, handler) {
  server.registerTool(name, { description, inputSchema: z.object(shape), annotations }, async (params) => {
    try {
      return ok(await handler(params));
    } catch (error) {
      return fail(error);
    }
  });
}

/** Client-API request helper bound to the upstream client (keeps its retry, rate limit and circuit breaker). */
function clientApi(client) {
  return (method, path, body, options) =>
    client.doRequestFn(method, path, client.requireClientKey(), body, "application/json", options);
}

const sid = (id) => `/api/client/servers/${encodeURIComponent(id)}`;

function normDir(dir) {
  const d = posix.normalize(dir || "/");
  return d.startsWith("/") ? d : `/${d}`;
}

async function listDir(api, id, directory) {
  const res = await api("GET", `${sid(id)}/files/list?directory=${encodeURIComponent(directory)}`);
  return res.data.map((item) => item.attributes);
}

/** Uploads raw bytes through Wings' signed upload URL (multipart, binary-safe). */
async function uploadBytes(api, id, directory, files) {
  const signed = await api("GET", `${sid(id)}/files/upload`);
  const url = new URL(signed.attributes.url);
  url.searchParams.set("directory", directory);
  const form = new FormData();
  for (const f of files) {
    form.append("files", new Blob([f.bytes]), f.name);
  }
  const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload rejected by the node (HTTP ${res.status}). ${text.slice(0, 300)}`);
  }
}

async function uploadAndVerify(api, id, directory, files, overwrite) {
  const before = await listDir(api, id, directory).catch((e) => {
    if (e && e.status === 404) return [];
    throw e;
  });
  const existing = new Set(before.map((f) => f.name));
  const clashes = files.filter((f) => existing.has(f.name)).map((f) => f.name);
  if (clashes.length && !overwrite) {
    throw new Error(`Refusing to overwrite existing file(s) in ${directory}: ${clashes.join(", ")}. Pass overwrite=true to replace them.`);
  }
  await uploadBytes(api, id, directory, files);
  const after = await listDir(api, id, directory);
  const sizes = new Map(after.map((f) => [f.name, f.size]));
  const results = files.map((f) => ({
    file: posix.join(directory, f.name),
    local_bytes: f.bytes.length,
    server_bytes: sizes.get(f.name) ?? null,
    verified: sizes.get(f.name) === f.bytes.length,
    replaced: existing.has(f.name),
  }));
  return { directory, uploaded: results, all_verified: results.every((r) => r.verified) };
}

export const EXTRA_APP_TOOLS = 2;
export const EXTRA_CLIENT_TOOLS = 20;

export function registerExtraTools(server, client) {
  // ─── Application API ───────────────────────────────────────────────────────
  tool(
    server,
    "find_servers",
    "Search servers by name (or uuid / external_id / docker image) instead of paging through list_servers. Returns id, identifier, name, node, status and limits for each match. Requires Application API key.",
    {
      query: z.string().min(1).describe("Text to match, e.g. 'MintSMP'"),
      field: z.enum(["name", "uuid", "external_id", "image"]).optional().describe("Field to filter on (default: name)"),
      per_page: z.number().int().min(1).max(100).optional().describe("Max results (default 50)"),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ query, field = "name", per_page = 50 }) => {
      const q = new URLSearchParams({ [`filter[${field}]`]: query, per_page: String(per_page) });
      const res = await client.appRequestFn("GET", `/api/application/servers?${q}`);
      const servers = res.data.map(({ attributes: a }) => ({
        id: a.id,
        identifier: a.identifier,
        uuid: a.uuid,
        name: a.name,
        node: a.node,
        user: a.user,
        suspended: a.suspended,
        status: a.status,
        limits: a.limits,
      }));
      return { query, field, count: servers.length, total: res.meta?.pagination?.total ?? servers.length, servers };
    },
  );

  tool(
    server,
    "list_locations",
    "List node locations (id, short code, description). Requires Application API key.",
    {},
    { readOnlyHint: true, openWorldHint: true },
    async () => {
      const res = await client.appRequestFn("GET", "/api/application/locations?per_page=100");
      return { locations: res.data.map((l) => l.attributes) };
    },
  );

  if (!client.hasClientKey) return;
  const api = clientApi(client);

  // ─── Files ─────────────────────────────────────────────────────────────────
  tool(
    server,
    "upload_file",
    "Upload one or more files from this computer to a server directory. Binary-safe (schematics, jars, worlds, images): uses the panel's signed upload URL instead of write_file, which only handles text. Verifies each file's size on the server afterwards. Refuses to replace existing files unless overwrite=true. Requires Client API key.",
    {
      server_identifier: SERVER_ID,
      local_paths: z.array(z.string().min(1)).min(1).describe("Absolute paths of local files to upload"),
      directory: z.string().min(1).describe("Target directory on the server, e.g. /plugins/FastAsyncWorldEdit/schematics"),
      remote_name: z.string().min(1).optional().describe("Name to give the file on the server (only when uploading a single file)"),
      overwrite: z.boolean().optional().describe("Replace files that already exist (default false)"),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier, local_paths, directory, remote_name, overwrite = false }) => {
      if (remote_name && local_paths.length !== 1) throw new Error("remote_name can only be used with a single file.");
      if (remote_name && /[\\/]/.test(remote_name)) throw new Error("remote_name must be a plain file name, not a path.");
      const files = [];
      for (const p of local_paths) {
        if (!isAbsolute(p)) throw new Error(`Local path must be absolute: ${p}`);
        if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`Not a file: ${p}`);
        files.push({ name: remote_name ?? basename(p), bytes: await readFile(p) });
      }
      return uploadAndVerify(api, server_identifier, normDir(directory), files, overwrite);
    },
  );

  tool(
    server,
    "upload_file_base64",
    "Create or replace a file on the server from base64-encoded bytes. Binary-safe alternative to write_file for clients that cannot share a local path. Verifies size afterwards. Requires Client API key.",
    {
      server_identifier: SERVER_ID,
      file_path: z.string().min(1).describe("Absolute destination path on the server, e.g. /plugins/X/data.bin"),
      content_base64: z.string().min(1).describe("File contents, base64-encoded"),
      overwrite: z.boolean().optional().describe("Replace the file if it already exists (default false)"),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier, file_path, content_base64, overwrite = false }) => {
      const full = normDir(file_path);
      const bytes = Buffer.from(content_base64, "base64");
      return uploadAndVerify(api, server_identifier, posix.dirname(full), [{ name: posix.basename(full), bytes }], overwrite);
    },
  );

  tool(
    server,
    "download_file_to_local",
    "Download a file from the server and save it on this computer (binary-safe). Refuses to replace an existing local file unless overwrite=true. Requires Client API key.",
    {
      server_identifier: SERVER_ID,
      file_path: z.string().min(1).describe("Absolute path of the file on the server"),
      local_path: z.string().min(1).describe("Absolute local path to save to; its parent folder must exist"),
      overwrite: z.boolean().optional().describe("Replace an existing local file (default false)"),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier, file_path, local_path, overwrite = false }) => {
      if (!isAbsolute(local_path)) throw new Error("local_path must be absolute.");
      if (existsSync(local_path) && !overwrite) throw new Error(`Local file exists: ${local_path}. Pass overwrite=true to replace it.`);
      if (!existsSync(dirname(local_path))) throw new Error(`Local folder does not exist: ${dirname(local_path)}`);
      const { url } = await client.downloadFile(server_identifier, file_path);
      const res = await fetch(url, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
      const bytes = Buffer.from(await res.arrayBuffer());
      await writeFile(local_path, bytes);
      return { file_path, local_path, bytes: bytes.length };
    },
  );

  tool(
    server,
    "pull_file",
    "Have the node download a file from a public URL straight into a server directory (good for plugin jars and large files). Requires Client API key and remote downloads enabled on the node.",
    {
      server_identifier: SERVER_ID,
      url: z.string().url().describe("http(s) URL to download"),
      directory: z.string().min(1).describe("Target directory on the server"),
      filename: z.string().min(1).optional().describe("File name to save as (default: from the URL)"),
      use_header: z.boolean().optional().describe("Use the Content-Disposition header for the file name"),
      foreground: z.boolean().optional().describe("Wait for the download to finish before returning"),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier, url, directory, filename, use_header, foreground }) => {
      const body = { url, directory: normDir(directory) };
      if (filename) body.filename = filename;
      if (use_header !== undefined) body.use_header = use_header;
      if (foreground !== undefined) body.foreground = foreground;
      await api("POST", `${sid(server_identifier)}/files/pull`, body);
      return { success: true, url, directory: body.directory, filename: filename ?? null };
    },
  );

  tool(
    server,
    "copy_file",
    "Duplicate a file in place (the panel names the copy like 'name copy.ext'). Requires Client API key.",
    { server_identifier: SERVER_ID, file_path: z.string().min(1).describe("Absolute path of the file to copy") },
    { openWorldHint: true },
    async ({ server_identifier, file_path }) => {
      await api("POST", `${sid(server_identifier)}/files/copy`, { location: file_path });
      return { success: true, copied: file_path };
    },
  );

  tool(
    server,
    "chmod_files",
    "Change permissions of files or folders, e.g. make a script executable. Requires Client API key.",
    {
      server_identifier: SERVER_ID,
      root: z.string().min(1).describe("Directory containing the files"),
      files: z
        .array(z.object({ file: z.string().min(1), mode: z.string().regex(/^[0-7]{3,4}$/).describe("Octal mode, e.g. '755'") }))
        .min(1),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier, root, files }) => {
      await api("POST", `${sid(server_identifier)}/files/chmod`, { root: normDir(root), files });
      return { success: true, root: normDir(root), files };
    },
  );

  // ─── Schedules & backups ──────────────────────────────────────────────────
  tool(
    server,
    "execute_schedule",
    "Run a schedule's tasks right now instead of waiting for its cron time. Requires Client API key.",
    { server_identifier: SERVER_ID, schedule_id: z.number().int().describe("Schedule ID from list_schedules") },
    { openWorldHint: true },
    async ({ server_identifier, schedule_id }) => {
      await api("POST", `${sid(server_identifier)}/schedules/${schedule_id}/execute`);
      return { success: true, schedule_id };
    },
  );

  tool(
    server,
    "get_backup",
    "Get one backup's details (size, checksum, completion, lock state). Requires Client API key.",
    { server_identifier: SERVER_ID, backup_uuid: z.string().min(1) },
    { readOnlyHint: true, openWorldHint: true },
    async ({ server_identifier, backup_uuid }) => (await api("GET", `${sid(server_identifier)}/backups/${backup_uuid}`)).attributes,
  );

  tool(
    server,
    "toggle_backup_lock",
    "Lock or unlock a backup (locked backups can't be deleted or rotated out). Toggles the current state. Requires Client API key.",
    { server_identifier: SERVER_ID, backup_uuid: z.string().min(1) },
    { openWorldHint: true },
    async ({ server_identifier, backup_uuid }) => {
      const res = await api("POST", `${sid(server_identifier)}/backups/${backup_uuid}/lock`);
      return { backup_uuid, is_locked: res?.attributes?.is_locked ?? null };
    },
  );

  // ─── Network allocations ──────────────────────────────────────────────────
  tool(
    server,
    "list_server_allocations",
    "List the ports (allocations) assigned to a server, with notes and which one is primary. Requires Client API key.",
    { server_identifier: SERVER_ID },
    { readOnlyHint: true, openWorldHint: true },
    async ({ server_identifier }) => {
      const res = await api("GET", `${sid(server_identifier)}/network/allocations`);
      return { allocations: res.data.map((a) => a.attributes) };
    },
  );

  tool(
    server,
    "add_server_allocation",
    "Auto-assign another free port to the server (needs automatic allocation enabled on the panel and spare allocation slots). Requires Client API key.",
    { server_identifier: SERVER_ID },
    { openWorldHint: true },
    async ({ server_identifier }) => (await api("POST", `${sid(server_identifier)}/network/allocations`)).attributes,
  );

  tool(
    server,
    "update_allocation_notes",
    "Set the notes text on one of the server's allocations. Requires Client API key.",
    { server_identifier: SERVER_ID, allocation_id: z.number().int(), notes: z.string().max(255) },
    { openWorldHint: true },
    async ({ server_identifier, allocation_id, notes }) =>
      (await api("POST", `${sid(server_identifier)}/network/allocations/${allocation_id}`, { notes })).attributes,
  );

  tool(
    server,
    "set_primary_allocation",
    "Make one of the server's allocations its primary IP/port. Requires Client API key.",
    { server_identifier: SERVER_ID, allocation_id: z.number().int() },
    { openWorldHint: true },
    async ({ server_identifier, allocation_id }) =>
      (await api("POST", `${sid(server_identifier)}/network/allocations/${allocation_id}/primary`)).attributes,
  );

  tool(
    server,
    "remove_server_allocation",
    "Unassign a non-primary allocation from the server. Requires Client API key.",
    { server_identifier: SERVER_ID, allocation_id: z.number().int() },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier, allocation_id }) => {
      await api("DELETE", `${sid(server_identifier)}/network/allocations/${allocation_id}`);
      return { success: true, removed: allocation_id };
    },
  );

  // ─── Startup & settings ───────────────────────────────────────────────────
  tool(
    server,
    "update_startup_variable",
    "Change a user-editable startup variable (e.g. SERVER_JARFILE, MINECRAFT_VERSION). Takes effect on next restart. Requires Client API key.",
    {
      server_identifier: SERVER_ID,
      key: z.string().min(1).describe("Variable env name from get_startup_variables, e.g. SERVER_JARFILE"),
      value: z.string().describe("New value"),
    },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier, key, value }) =>
      (await api("PUT", `${sid(server_identifier)}/startup/variable`, { key, value })).attributes,
  );

  tool(
    server,
    "rename_server",
    "Change a server's display name (and optionally description) as its owner/subuser. Requires Client API key.",
    { server_identifier: SERVER_ID, name: z.string().min(1).max(191), description: z.string().optional() },
    { openWorldHint: true },
    async ({ server_identifier, name, description }) => {
      const body = { name };
      if (description !== undefined) body.description = description;
      await api("POST", `${sid(server_identifier)}/settings/rename`, body);
      return { success: true, name };
    },
  );

  tool(
    server,
    "set_docker_image",
    "Switch the server's Docker image to another one its egg allows (e.g. a different Java version). Requires Client API key.",
    { server_identifier: SERVER_ID, docker_image: z.string().min(1).describe("Image from get_startup_variables 'docker_images'") },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier, docker_image }) => {
      await api("PUT", `${sid(server_identifier)}/settings/docker-image`, { docker_image });
      return { success: true, docker_image };
    },
  );

  tool(
    server,
    "reinstall_server_client",
    "Re-run the egg install script for a server using only the Client API (no admin key needed). Can overwrite server files. Requires Client API key.",
    { server_identifier: SERVER_ID },
    { destructiveHint: true, openWorldHint: true },
    async ({ server_identifier }) => {
      await api("POST", `${sid(server_identifier)}/settings/reinstall`);
      return { success: true, reinstalling: server_identifier };
    },
  );

  tool(
    server,
    "list_client_servers",
    "List servers this Client API key can access (works for subusers without admin rights). By default only servers the account owns or is a subuser on; panel admins can pass type='admin-all' to include every server. Supports a partial name filter. Requires Client API key.",
    {
      name: z.string().optional().describe("Optional partial name filter"),
      type: z
        .enum(["owner", "admin", "admin-all"])
        .optional()
        .describe("owner = only owned; admin = servers the admin doesn't own; admin-all = every server (admins only). Default: owned + subuser"),
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ name, type, page = 1, per_page = 50 }) => {
      const q = new URLSearchParams({ page: String(page), per_page: String(per_page) });
      if (name) q.set("filter[name]", name);
      if (type) q.set("type", type);
      const res = await api("GET", `/api/client?${q}`);
      return {
        pagination: res.meta?.pagination,
        servers: res.data.map(({ attributes: a }) => ({
          identifier: a.identifier,
          uuid: a.uuid,
          name: a.name,
          node: a.node,
          is_owner: a.server_owner,
          status: a.status,
          limits: a.limits,
        })),
      };
    },
  );

  tool(
    server,
    "make_directories",
    "Create a nested directory path (like mkdir -p), creating each missing level. Requires Client API key.",
    { server_identifier: SERVER_ID, path: z.string().min(1).describe("Absolute directory path, e.g. /plugins/X/data/2026") },
    { openWorldHint: true },
    async ({ server_identifier, path }) => {
      const parts = normDir(path).split("/").filter(Boolean);
      const created = [];
      let parent = "/";
      for (const part of parts) {
        const entries = await listDir(api, server_identifier, parent);
        const hit = entries.find((e) => e.name === part);
        if (!hit) {
          await api("POST", `${sid(server_identifier)}/files/create-folder`, { root: parent, name: part });
          created.push(posix.join(parent, part));
        } else if (hit.is_file) {
          throw new Error(`${posix.join(parent, part)} exists and is a file.`);
        }
        parent = posix.join(parent, part);
      }
      return { path: parent, created };
    },
  );
}
