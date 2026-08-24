type ToolContext = {
  config?: Record<string, unknown>;
};

type ToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
};

type OpenClawPluginApi = {
  registerTool: (tool: ToolDefinition) => void;
};

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
            ? {
                "Content-Type": "application/json",
              }
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
        body = {
          raw: text,
        };
      }
    }

    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Jarvis Builder returned HTTP ${response.status}`;

      throw new Error(message);
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function asTextResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export default function register(
  api: OpenClawPluginApi,
): void {
  api.registerTool({
    name: "jarvis_build_tool",

    description:
      "Create a new Jarvis Builder tool proposal. This creates a proposal only and does not publish or merge code.",

    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "toolName",
        "description",
      ],
      properties: {
        toolName: {
          type: "string",
          minLength: 1,
          description:
            "Short name for the tool to create.",
        },

        description: {
          type: "string",
          minLength: 1,
          description:
            "What the requested tool should do.",
        },

        requirements: {
          type: "string",
          description:
            "Optional implementation requirements or constraints.",
        },
      },
    },

    async execute(args) {
      const toolName =
        String(args.toolName || "").trim();

      const description =
        String(args.description || "").trim();

      const requirements =
        String(args.requirements || "").trim();

      if (!toolName || !description) {
        throw new Error(
          "toolName and description are required",
        );
      }

      const result = await builderRequest(
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

      return asTextResult(result);
    },
  });

  api.registerTool({
    name: "jarvis_get_proposal",

    description:
      "Retrieve a Jarvis Builder proposal by toolId.",

    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "toolId",
      ],
      properties: {
        toolId: {
          type: "string",
          minLength: 1,
          description:
            "The proposal toolId returned by jarvis_build_tool.",
        },
      },
    },

    async execute(args) {
      const toolId =
        String(args.toolId || "").trim();

      if (!toolId) {
        throw new Error(
          "toolId is required",
        );
      }

      const result = await builderRequest(
        `/proposal/${encodeURIComponent(toolId)}`,
      );

      return asTextResult(result);
    },
  });

  api.registerTool({
    name: "jarvis_run_tests",

    description:
      "Run Jarvis Builder validation for an existing proposal. This performs validation only and does not publish or merge code.",

    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "toolId",
      ],
      properties: {
        toolId: {
          type: "string",
          minLength: 1,
          description:
            "The proposal toolId to validate.",
        },

        testType: {
          type: "string",
          default: "all",
          description:
            "Validation type. Use all unless a different supported test type is required.",
        },
      },
    },

    async execute(args) {
      const toolId =
        String(args.toolId || "").trim();

      const testType =
        String(args.testType || "all").trim();

      if (!toolId) {
        throw new Error(
          "toolId is required",
        );
      }

      const result = await builderRequest(
        "/run-tests",
        {
          method: "POST",
          body: JSON.stringify({
            toolId,
            testType,
          }),
        },
      );

      return asTextResult(result);
    },
  });
}
