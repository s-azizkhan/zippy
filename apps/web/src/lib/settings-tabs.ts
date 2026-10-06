export const SETTINGS_TABS = [
  { value: "org", label: "Organization", group: "General" },
  { value: "database", label: "Database", group: "General" },
  { value: "folders", label: "Working folders", group: "Workspace" },
  { value: "knowledge", label: "Knowledge base", group: "Workspace" },
  { value: "tools", label: "Zipper tool defaults", group: "Zippers" },
  { value: "mcp", label: "MCP servers", group: "Zippers" },
  { value: "connectors", label: "Connectors", group: "Integrations" },
  { value: "linear", label: "Linear", group: "Integrations" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];
