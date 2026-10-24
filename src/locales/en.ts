import * as app from "./parts/app";
import * as detail from "./parts/detail";
import * as list from "./parts/list";
import * as config from "./parts/config";

export const en = { ...app.en, ...detail.en, ...list.en, ...config.en };
