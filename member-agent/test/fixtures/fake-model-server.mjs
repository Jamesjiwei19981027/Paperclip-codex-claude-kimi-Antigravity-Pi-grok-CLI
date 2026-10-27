import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** A deterministic fake Responses endpoint. It binds loopback only and logs no request body or headers. */
export async function startFakeModelServer({ port = 0, text = "B2_FAKE_MODEL_OK", delayMs = 0 } = {}) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 600_000) {
    throw new TypeError("delayMs 必须是 0 到 600000 之间的整数");
  }
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume without retaining prompt or credentials. */ }
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404, { "content-type": "text/plain" }); response.end("not found"); return;
    }
    // A deliberate delay keeps Codex alive for cancellation and timeout acceptance checks.
    if (delayMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        response.once("close", () => { clearTimeout(timer); resolve(); });
      });
      if (response.destroyed) return;
    }
    const message = { id: "msg_fake", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const result = { id: "resp_fake", object: "response", created_at: 1700000000, status: "completed", model: "gpt-5.4", output: [message], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 } } };
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("response.created", { response: { ...result, status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } });
    emit("response.content_part.added", { item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: text });
    emit("response.output_text.done", { item_id: message.id, output_index: 0, content_index: 0, text });
    emit("response.output_item.done", { output_index: 0, item: message });
    emit("response.completed", { response: result });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake model server did not bind a TCP port");
  return { server, port: address.port, url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requestedPort = Number(process.argv[2] ?? 43123);
  const requestedDelayMs = Number(process.argv[3] ?? 0);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535 || !Number.isInteger(requestedDelayMs) || requestedDelayMs < 0 || requestedDelayMs > 600_000) {
    console.error("用法：node fake-model-server.mjs [回环端口] [响应延迟毫秒]"); process.exitCode = 2;
  } else {
    const fake = await startFakeModelServer({ port: requestedPort, delayMs: requestedDelayMs });
    console.log(`FAKE_MODEL_LISTENING ${fake.url} DELAY_MS=${requestedDelayMs}`);
    const stop = () => { void fake.close().then(() => process.exit(0)); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }
}
