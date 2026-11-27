import { BOT_SHARING_ENABLED } from "../shared/bot-sharing.ts";

/** DUSK_BOT_SHARING=on lets the sharing tests exercise the routes while the shipped flag is off. */
export const botSharingOn = (): boolean => BOT_SHARING_ENABLED || process.env.DUSK_BOT_SHARING === "on";
