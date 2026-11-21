import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { HOSTED_MCP_APPS } from "@/lib/hosted-mcp-apps";
import { TOKEN_APPS, type TokenAppId } from "../../../shared/app-tokens";
import { NATIVE_CONNECTORS } from "../../../shared/native-connectors";
import type { DirectoryApp } from "../../../shared/connector-directory";
import type { ToolkitCard } from "../ServiceIcon";
import { grokCategories, type AppEntry } from "./catalog";
import { composioLogo } from "./composio-snapshot";
import { appLogo } from "./logos";

/** Any MCP server by its URL, kept with the MCP servers Settings has. */
export const CUSTOM_MCP = "custom-mcp";
export const GMAIL = "gmail";

function logoIcon(...names: string[]): AppEntry["icon"] {
  const logo = appLogo(...names);
  return logo ? { image: logo.src, padded: logo.padded, background: logo.background, scale: logo.scale } : {};
}

/** Grok's logo when it has one, then the catalog's own mark, then Composio's mark for the slug: never a favicon. */
export function cardIcon(card: ToolkitCard): AppEntry["icon"] {
  const known = logoIcon(card.slug, card.label);
  if (known.image) return known;
  return { logo: card.logo ?? composioLogo(card.slug), padded: true };
}

/** Our bundled logo when we have one, else the vendor site's own icon through /api/site-icon. */
export function remoteIcon(app: DirectoryApp): AppEntry["icon"] {
  const known = logoIcon(app.id, app.label);
  return known.image ? known : { domain: app.domain };
}

const TOKEN_CATEGORY: Record<TokenAppId, string> = {
  github: "developer code", notion: "documents notes", linear: "project management", airtable: "database", todoist: "task",
  trello: "project management", clickup: "project management", hubspot: "crm", jira: "project management", shopify: "commerce",
  stripe: "payments", cloudflare: "developer cloud", googledrive: "file storage", dropbox: "file storage",
};

export function nativeEntries(): AppEntry[] {
  return [
    { id: "1password", kind: "logins", label: "1Password", description: t("connectApps.onePassword.description"), categories: ["credentials"], icon: logoIcon("1password"), website: "1password.com", keywords: "password vault logins" },
    { id: "email", kind: "native", label: t("email.title"), description: t("email.description"), categories: ["communication"], icon: { glyph: "envelope", glyphPaint: "rgb(229 47 139)" }, keywords: "email mail imap smtp mailbox" },
    { id: "x", kind: "native", label: t("apps.x.title"), description: t("apps.x.description"), categories: ["marketing"], icon: logoIcon("x"), website: "x.com", keywords: "x twitter posts", oneClick: true },
    { id: GMAIL, kind: "native", label: "Gmail", description: t("tokenApps.gmail.description"), categories: ["communication"], icon: logoIcon("gmail"), website: "mail.google.com", keywords: "gmail google mail app password imap" },
    ...TOKEN_APPS.map((app): AppEntry => ({
      id: app.id, kind: "token", label: app.label, description: t(`tokenApps.description.${app.id}` as LocaleKey), categories: grokCategories([TOKEN_CATEGORY[app.id]]),
      icon: logoIcon(app.id, app.label).image ? logoIcon(app.id, app.label) : { domain: app.domain }, website: app.domain, keywords: `${app.id} token api key`,
      // a sign-in that comes back by itself is one click; a device code to type, or a token to paste, is not
      ...(NATIVE_CONNECTORS.some((one) => one.id === app.id && one.flow !== "device") ? { oneClick: true } : {}),
    })),
    { id: CUSTOM_MCP, kind: "native", label: t("connectApps.customMcp"), description: t("connectApps.customMcp.description"), categories: ["code"], icon: { glyph: "plug" }, keywords: "custom mcp server url remote http headers oauth" },
    ...HOSTED_MCP_APPS.map((app): AppEntry => ({
      id: app.id, kind: "hosted", label: app.label, description: t(app.description), categories: ["finance"],
      icon: "image" in app.icon ? { image: app.icon.image } : { glyph: "credit-card", glyphPaint: "rgb(48 49 54)" }, website: new URL(app.url).hostname.replace(/^mcp\./, ""), keywords: app.keywords, oneClick: true,
    })),
  ];
}
