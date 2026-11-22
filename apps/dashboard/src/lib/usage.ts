import { siteUrl } from "./site";

export const APP_LINK = "duskbot://";
export const DOWNLOAD_URL = siteUrl("/download");
/** the iphone app's store page (apps/site/releases.json "ios") */
export const IOS_APP_URL = "https://apps.apple.com/app/id6834725640";
/** the android app is an apk on the download page, not on google play */
export const ANDROID_APP_URL = siteUrl("/download#android");
/** the phone path that works today: the phone app signs in with this account and links a dusk cloud by itself */
export const PHONE_APP = "on your phone, get dusk bot and sign in with this email. your dusk cloud links on its own. bots on your own computer: open settings, phone in dusk bot there and scan the code with the phone's camera.";
export const API_DOCS = "https://github.com/goatedgrokbotalternative/duskbot/blob/custom/docs/bot-api.md";
