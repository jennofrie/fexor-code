import { expect, test } from "bun:test";
import { getNvidiaApiKey } from "./nvidia-auth.js";

test("removes an environment credential after resolving it", () => {
  process.env.NVIDIA_API_KEY = "test-nvidia-key";

  expect(getNvidiaApiKey()).toBe("test-nvidia-key");
  expect(process.env.NVIDIA_API_KEY).toBeUndefined();
});
