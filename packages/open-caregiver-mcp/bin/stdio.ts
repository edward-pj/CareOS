import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CareService, MemoryAdapter, createCareMcpServer, createSeed } from "../src/server.js";

const service = new CareService(new MemoryAdapter(createSeed(Date.now())));
await createCareMcpServer(service).connect(new StdioServerTransport());
