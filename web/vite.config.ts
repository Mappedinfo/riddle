import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), mode === "pages" ? "VITE_" : "");
  const isQwen = Boolean(env.QWEN_AI_KEY_PAY || env.QWEN_AI_KEY);
  const apiKey = env.QWEN_AI_KEY_PAY || env.QWEN_AI_KEY || env.DEEPSEEK_API_KEY || "";
  const apiBase = (env.QWEN_API_URL_PAY || env.QWEN_API_URL || env.DEEPSEEK_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const model = env.QWEN_API_MODEL || env.DEEPSEEK_API_MODEL || "qwen3.8-max";
  const publicProxy = env.VITE_ORACLE_PROXY_URL || "";
  const apiUrl = new URL(apiBase);
  const completionPath = `${apiUrl.pathname.replace(/\/+$/, "")}/chat/completions`;

  return {
    base: "./",
    define: {
      __MANAGED_ORACLE__: JSON.stringify(Boolean(apiKey || publicProxy)),
      __ORACLE_SUPPORTS_VISION__: JSON.stringify(isQwen || Boolean(publicProxy) || !apiKey),
      __ORACLE_ENDPOINT__: JSON.stringify(publicProxy || "/api/oracle"),
      __DEFAULT_ORACLE_URL__: JSON.stringify(apiBase),
      __DEFAULT_ORACLE_MODEL__: JSON.stringify(model),
    },
    server: {
      port: 4173,
      proxy: apiKey ? {
        "/api/oracle": {
          target: apiUrl.origin,
          changeOrigin: true,
          secure: true,
          rewrite: () => completionPath,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        },
      } : undefined,
    },
  };
});
