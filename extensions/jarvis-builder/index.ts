import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_BUILDER_URL =
  "https://jarvis-builder-qoaz-production.up.railway.app";

function getBuilderUrl(): string {
  const value =
    process.env.JARVIS_BUILDER_URL?.trim() ||
    DEFAULT_BUILDER_URL;

  return value.replace(/\/+$/, "");
}

async function builderRequest(
  endpoint: string,
  options: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 120_000);

  try {
    const response = await fetch(
      `${getBuilderUrl()}${endpoint}`,
      {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(options.body
            ? { "Content-Type": "application/json" }
            : {}),
          ...(options.headers || {}),
        },
      },
    );

    const text = await response.text();

    let body: unknown = null;

    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (!response.ok) {
      let message =
        `Jarvis Builder returned HTTP ${response.status}`;

      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
      ) {
        message = (body as { error: string }).error;
      }

      throw new Error(message);
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function result(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    details: value,
  };
}

export default definePluginEntry({
  id: "jarvis-builder",
  name: "Jarvis Builder",
  description:
    "OpenClaw tools for creating, inspecting and validating Jarvis Builder proposals.",

  register(api) {
    api.registerTool({
      name: "jarvis_build_tool",
      description:
        "Create a new Jarvis Builder tool proposal. Creates a proposal only. Never publishes or merges code.",

      parameters: Type.Object(
        {
          toolName: Type.String({
            minLength: 1,
            description: "Short name for the tool to create.",
          }),

          description: Type.String({
            minLength: 1,
            description: "What the requested tool should do.",
          }),

          requirements: Type.Optional(
            Type.String({
              description:
                "Optional implementation requirements or constraints.",
            }),
          ),
        },
        {
          additionalProperties: false,
        },
      ),

      async execute(_id, params) {
        const toolName = params.toolName.trim();
        const description = params.description.trim();
        const requirements =
          params.requirements?.trim() || "";

        const response = await builderRequest(
          "/build-tool",
          {
            method: "POST",
            body: JSON.stringify({
              toolName,
              description,
              requirements,
            }),
          },
        );

        return result(response);
      },
    });

    api.registerTool({
      name: "jarvis_get_proposal",
      description:
        "Retrieve an existing Jarvis Builder proposal by toolId.",

      parameters: Type.Object(
        {
          toolId: Type.String({
            minLength: 1,
            description:
              "Proposal toolId returned by jarvis_build_tool.",
          }),
        },
        {
          additionalProperties: false,
        },
      ),

      async execute(_id, params) {
        const toolId = params.toolId.trim();

        const response = await builderRequest(
          `/proposal/${encodeURIComponent(toolId)}`,
        );

        return result(response);
      },
    });

    api.registerTool({
      name: "jarvis_run_tests",
      description:
        "Validate an existing Jarvis Builder proposal. Validation only. Never publishes or merges code.",

      parameters: Type.Object(
        {
          toolId: Type.String({
            minLength: 1,
            description:
              "Proposal toolId to validate.",
          }),

          testType: Type.Optional(
            Type.String({
              default: "all",
              description:
                "Validation type. Use all unless another supported type is required.",
            }),
          ),
        },
        {
          additionalProperties: false,
        },
      ),

      async execute(_id, params) {
        const toolId = params.toolId.trim();
        const testType =
          params.testType?.trim() || "all";

        const response = await builderRequest(
          "/run-tests",
          {
            method: "POST",
            body: JSON.stringify({
              toolId,
              testType,
            }),
          },
        );

        return result(response);
      },
    });
  },
});
