export const SETTINGS_TABS = [
  { value: "org", label: "Organization", group: "General" },
  { value: "folders", label: "Working folders", group: "Workspace" },
  { value: "tools", label: "Agent tool defaults", group: "Agents" },
  { value: "mcp", label: "MCP servers", group: "Agents" },
  { value: "connectors", label: "Connectors", group: "Integrations" },
  { value: "linear", label: "Linear", group: "Integrations" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];
