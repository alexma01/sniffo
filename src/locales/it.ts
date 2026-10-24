import type { en } from "./en";
import * as app from "./parts/app";
import * as detail from "./parts/detail";
import * as list from "./parts/list";
import * as config from "./parts/config";

export const it: Record<keyof typeof en, string> = { ...app.it, ...detail.it, ...list.it, ...config.it };
