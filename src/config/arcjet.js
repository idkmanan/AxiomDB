import arcjet, { shield, detectBot, slidingWindow } from "@arcjet/node";

const isDev = process.env.NODE_ENV === "development";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: isDev ? "DRY_RUN" : "LIVE" }),
    detectBot({
      mode: isDev ? "DRY_RUN" : "LIVE",
      allow: [
        "CATEGORY:SEARCH_ENGINE",
        "CATEGORY:PREVIEW",
      ],
    }),
    slidingWindow({
      mode: isDev ? "DRY_RUN" : "LIVE",
      interval: 2,
      max: isDev ? 100 : 5,
    }),
  ],
});

export default aj;