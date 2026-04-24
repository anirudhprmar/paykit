import type { Server } from "node:http";

import { startHub } from "./hub";

export default async function setup(): Promise<() => Promise<void>> {
  let server: Server;
  try {
    server = await startHub();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
      throw new Error(
        "Hub port 4567 already in use. Kill any stale webhook server before running tests.", { cause: error },
      );
    }
    throw error;
  }
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
