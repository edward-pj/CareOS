import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/storage/memoryAdapter.js";
import { runStorageContract } from "../src/testing/storageContract.js";

runStorageContract({ describe, it, expect }, "memory", () => new MemoryStorage());
