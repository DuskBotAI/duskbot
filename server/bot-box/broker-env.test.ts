import { describe, expect, it } from "vitest";

import { BROKERED_PROVIDERS, brokerRewrite, usableUpstream } from "./broker-env.ts";

const token = `dusk_t0_${"a".repeat(48)}`;

describe("the broker's rewrite of a spawn's environment", () => {
  it("replaces each provider key with the token and points its base URL at the broker, keeping the real key in the grant", () => {
    const { env, grants, unbrokered } = brokerRewrite({
      PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-real", OPENAI_API_KEY: "sk-openai-real", OPENAI_BASE_URL: "https://openrouter.ai/api/v1/",
      GEMINI_API_KEY: "gm-real", XAI_API_KEY: "xai-real", DUSK_COMMS_TOKEN: "cap",
    }, token, 18080);
    expect(env).toEqual({
      PATH: "/usr/bin", DUSK_COMMS_TOKEN: "cap", XAI_API_KEY: "xai-real",
      ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: `http://127.0.0.1:18080/b/${token}/anthropic`,
      OPENAI_API_KEY: token, OPENAI_BASE_URL: `http://127.0.0.1:18080/b/${token}/openai`,
      GEMINI_API_KEY: token, GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:18080/b/${token}/gemini`,
    });
    expect(grants).toEqual({
      anthropic: { upstream: "https://api.anthropic.com", headers: { "x-api-key": "sk-ant-real" } },
      openai: { upstream: "https://openrouter.ai/api/v1", headers: { authorization: "Bearer sk-openai-real" } },
      gemini: { upstream: "https://generativelanguage.googleapis.com", headers: { "x-goog-api-key": "gm-real" } },
    });
    expect(unbrokered).toEqual(["XAI_API_KEY"]);
    for (const key of ["sk-ant-real", "sk-openai-real", "gm-real"]) expect(JSON.stringify(env)).not.toContain(key);
  });

  it("changes nothing without a key, and leaves a token or a broker address alone", () => {
    expect(brokerRewrite({ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://proxy.example" }, token, 1)).toEqual({ env: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://proxy.example" }, grants: {}, unbrokered: [], args: [] });
    const already = { ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: `http://127.0.0.1:18080/b/${token}/anthropic` };
    expect(brokerRewrite(already, `dusk_t0_${"b".repeat(48)}`, 18080)).toEqual({ env: already, grants: {}, unbrokered: [], args: [] });
    const looped = { ANTHROPIC_API_KEY: "sk-real", ANTHROPIC_BASE_URL: `http://127.0.0.1:18080/b/${token}/anthropic` };
    expect(brokerRewrite(looped, token, 18080).grants).toEqual({});
  });

  it("a bearer-style Anthropic token and a bad base URL", () => {
    const { env, grants } = brokerRewrite({ ANTHROPIC_AUTH_TOKEN: "oauth-real", ANTHROPIC_BASE_URL: "ftp://x" }, token, 2);
    expect(grants).toEqual({ "anthropic-token": { upstream: "https://api.anthropic.com", headers: { authorization: "Bearer oauth-real" } } });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(token);
    expect(usableUpstream("https://u:p@host/", "https://d")).toBe("https://d");
    expect(usableUpstream("https://host/v1/", "https://d")).toBe("https://host/v1");
    expect(usableUpstream(undefined, "https://d")).toBe("https://d");
    expect(BROKERED_PROVIDERS.map((provider) => provider.name)).toEqual(["anthropic", "anthropic-token", "openai", "gemini", "google"]);
  });
});

describe("the broker's rewrite of a Codex command line", () => {
  const company = [
    "app-server", "-c", 'model_provider="dusk_company"', "-c", 'model_providers.dusk_company.name="Company"',
    "-c", 'model_providers.dusk_company.base_url="https://models.example.com/v1"', "-c", 'model_providers.dusk_company.env_key="DUSK_COMPANY_API_KEY"',
    "-c", 'model_providers.dusk_company.wire_api="responses"',
  ];

  it("points a provider whose key is in the environment at the broker, and puts the token in the key's variable", () => {
    const { env, grants, args } = brokerRewrite({ PATH: "/usr/bin", DUSK_COMPANY_API_KEY: "company-real" }, token, 18080, company);
    expect(env).toEqual({ PATH: "/usr/bin", DUSK_COMPANY_API_KEY: token });
    expect(grants).toEqual({ "codex-dusk_company": { upstream: "https://models.example.com/v1", headers: { authorization: "Bearer company-real" } } });
    expect(args).toEqual(company.map((arg) => arg.startsWith("model_providers.dusk_company.base_url=")
      ? `model_providers.dusk_company.base_url="http://127.0.0.1:18080/b/${token}/codex-dusk_company"` : arg));
    expect(JSON.stringify({ env, args })).not.toContain("company-real");
  });

  it("leaves a provider alone without its key, with a token, or with an address that is no upstream", () => {
    expect(brokerRewrite({ PATH: "/usr/bin" }, token, 18080, company)).toEqual({ env: { PATH: "/usr/bin" }, grants: {}, unbrokered: [], args: company });
    expect(brokerRewrite({ DUSK_COMPANY_API_KEY: token }, token, 18080, company).args).toEqual(company);
    const ftp = company.map((arg) => arg.replace("https://models.example.com/v1", "ftp://x"));
    expect(brokerRewrite({ DUSK_COMPANY_API_KEY: "k" }, token, 18080, ftp)).toMatchObject({ grants: {}, args: ftp, env: { DUSK_COMPANY_API_KEY: "k" } });
  });

  it("names a raw CODEX_API_KEY in the report", () => {
    expect(brokerRewrite({ CODEX_API_KEY: "sk-raw" }, token, 18080).unbrokered).toEqual(["CODEX_API_KEY"]);
  });
});
