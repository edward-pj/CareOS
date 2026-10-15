import { createServer } from "node:http";
import { createMcpHttpHandler } from "../http.js";
import { CareService, MemoryAdapter, createCareMcpServer, createSeed } from "../server.js";

const service = new CareService(new MemoryAdapter(createSeed(Date.now())));
const handle = createMcpHttpHandler({ createServer: () => createCareMcpServer(service) });
const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
  let body: unknown;
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    body = JSON.parse(Buffer.concat(chunks).toString() || "null");
  }
  await handle(req, res, body);
}).listen(port, () => console.error(`open-caregiver-mcp on http://localhost:${port}/mcp`));
