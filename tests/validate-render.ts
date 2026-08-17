/**
 * Playwright-based gallery render validation.
 *
 * Generates a gallery from test fixture data, opens it in headless Chromium,
 * and checks for JavaScript errors / missing elements.
 *
 * Usage:
 *   npx tsx tests/validate-render.ts [path/to/index.html]
 *
 * If no path is given, generates a temporary gallery from fixture data.
 */

import { chromium } from "playwright";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { generateHtml } from "../src/gallery.js";
import type { GalleryPost } from "../src/types.js";

const FIXTURES: GalleryPost[] = [
  {
    id: "1",
    author: "@alice",
    verified: true,
    avatar: "assets/alice-profile.jpg",
    date: "2024-03-01T12:00:00.000Z",
    url: "https://www.threads.net/post/1",
    likes: 100,
    replies: 5,
    reposts: 2,
    text: "A text-only post",
    media: [],
  },
  {
    id: "2",
    author: "@bob",
    verified: false,
    date: "2024-03-02T12:00:00.000Z",
    url: "https://www.threads.net/post/2",
    likes: 50,
    replies: 1,
    reposts: 0,
    text: "Post with an image",
    media: [{ type: "image", src: "assets/2-0.jpg" }],
  },
  {
    id: "3",
    author: "@carol",
    verified: false,
    date: "2024-03-03T12:00:00.000Z",
    url: "https://www.threads.net/post/3",
    likes: 200,
    replies: 10,
    reposts: 5,
    text: "Post with video",
    media: [
      {
        type: "video",
        src: "https://example.com/video.mp4",
        poster: "assets/3-0.jpg",
      },
    ],
  },
  {
    id: "4",
    author: "@dave",
    verified: false,
    date: "2024-03-04T12:00:00.000Z",
    url: "https://www.threads.net/post/4",
    likes: 10,
    replies: 0,
    reposts: 0,
    text: "Video without poster",
    media: [{ type: "video", src: "https://example.com/video2.mp4" }],
  },
  {
    id: "5",
    author: "@eve",
    verified: false,
    date: "2024-03-05T12:00:00.000Z",
    url: "https://www.threads.net/post/5",
    likes: 30,
    replies: 2,
    reposts: 1,
    text: "Check out my note",
    note: "This is a long note with detailed content.\n\nIt spans multiple paragraphs and contains useful information.",
    media: [],
  },
  {
    id: "6",
    author: "@frank",
    verified: false,
    date: "2024-03-06T12:00:00.000Z",
    url: "https://www.threads.net/post/6",
    likes: 15,
    replies: 1,
    reposts: 3,
    text: "This is such a great point",
    media: [],
    quotedPost: {
      author: "@grace",
      verified: true,
      text: "Original thought here with some detail",
      url: "https://www.threads.net/post/99",
      media: [{ type: "image", src: "assets/6-q0.jpg" }],
    },
  },
  {
    id: "7",
    author: "@eve",
    verified: false,
    date: "2024-03-07T12:00:00.000Z",
    url: "https://www.threads.net/post/7",
    likes: 8,
    replies: 0,
    reposts: 0,
    text: "You should add this to your agents.md",
    isReply: true,
    replyToAuthor: "@frank",
    media: [],
  },
  {
    id: "8",
    author: "@heidi",
    verified: false,
    date: "2024-03-08T12:00:00.000Z",
    url: "https://www.threads.net/post/8",
    likes: 20,
    replies: 2,
    reposts: 1,
    text: "Four images — carousel with dots",
    media: Array.from({ length: 4 }, (_, i) => ({
      type: "image" as const,
      src: `assets/8-${i}.jpg`,
    })),
  },
  {
    id: "9",
    author: "@ivan",
    verified: false,
    date: "2024-03-09T12:00:00.000Z",
    url: "https://www.threads.net/post/9",
    likes: 30,
    replies: 0,
    reposts: 0,
    text: "Twelve images — carousel with a count chip instead of dots",
    media: Array.from({ length: 12 }, (_, i) => ({
      type: "image" as const,
      src: `assets/9-${i}.jpg`,
    })),
  },
];

async function validate(htmlPath?: string): Promise<void> {
  let tempDir: string | null = null;
  let filePath: string;

  if (htmlPath) {
    filePath = htmlPath;
  } else {
    tempDir = await mkdtemp(join(tmpdir(), "threadsafe-validate-"));
    const html = generateHtml(FIXTURES);
    filePath = join(tempDir, "index.html");
    await writeFile(filePath, html, "utf-8");
    console.log(`Generated test gallery: ${filePath}`);
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Capture console errors (ignore resource loading failures for missing fixture assets)
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && !text.includes("ERR_FILE_NOT_FOUND") && !text.includes("ERR_CERT_AUTHORITY_INVALID")) {
      errors.push(`Console error: ${text}`);
    } else if (msg.type() === "warning") {
      warnings.push(`Console warning: ${text}`);
    }
  });

  // Capture page errors (uncaught exceptions)
  page.on("pageerror", (err) => {
    errors.push(`Page error: ${err.message}`);
  });

  const url = pathToFileURL(filePath).href;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Wait for gallery to initialize
  await page.waitForSelector(".post", { timeout: 5000 });

  // Check: posts rendered
  const postCount = await page.locator(".post").count();
  console.log(`Posts rendered: ${postCount}`);
  if (postCount === 0) {
    errors.push("No posts rendered");
  }

  // Check: header elements exist
  const headerChecks = ["#search", "#authorFilter", "#sortMode", ".logo"];
  for (const sel of headerChecks) {
    const count = await page.locator(sel).count();
    if (count === 0) errors.push(`Missing element: ${sel}`);
  }

  // Check: video containers rendered for video posts
  const videoContainers = await page.locator(".video-container").count();
  const videoElements = await page.locator(".post-video").count();
  console.log(
    `Video containers (click-to-play): ${videoContainers}, Direct video elements: ${videoElements}`
  );

  // Check: media wrappers render (single vs. carousel)
  const singleMedia = await page.locator(".media-single").count();
  const carousels = await page.locator(".media-carousel").count();
  const tracks = await page.locator(".media-track").count();
  console.log(`Single media: ${singleMedia}, Carousels: ${carousels}`);
  if (!htmlPath) {
    if (singleMedia === 0) errors.push("No .media-single wrappers rendered");
    if (carousels === 0) errors.push("No .media-carousel wrappers rendered");
    if (tracks !== carousels)
      errors.push(`.media-track count (${tracks}) does not match .media-carousel count (${carousels})`);

    // The 4-image post gets dots; the 12-image post gets a count chip.
    const dotStrips = await page.locator(".media-dots").count();
    const countChips = await page.locator(".media-count").count();
    console.log(`Dot strips: ${dotStrips}, Count chips: ${countChips}`);
    if (dotStrips === 0) errors.push("No .media-dots rendered for small carousel");
    if (countChips === 0) errors.push("No .media-count rendered for large carousel");

    const navButtons = await page.locator(".media-nav").count();
    if (navButtons !== carousels * 2)
      errors.push(`Expected ${carousels * 2} .media-nav buttons, found ${navButtons}`);
  }

  // Check: lightbox root exists and starts closed
  const lightboxes = await page.locator("#lightbox").count();
  if (lightboxes === 0) errors.push("Missing lightbox root (#lightbox)");
  const lightboxOpen = await page.locator("#lightbox.open").count();
  if (lightboxOpen > 0) errors.push("Lightbox is open on page load");

  // Check: rendered media respects the height cap. Only meaningful against a
  // real gallery — fixture asset paths point at files that do not exist, so
  // nothing decodes and every box is zero-height.
  if (htmlPath) {
    const MAX_MEDIA_HEIGHT = 700;
    const oversized = await page.evaluate((limit) => {
      const out: { src: string; height: number }[] = [];
      const imgs = Array.from(document.querySelectorAll("img.post-img"));
      for (const el of imgs) {
        const img = el as HTMLImageElement;
        if (!img.complete || img.naturalWidth === 0) continue;
        const h = img.getBoundingClientRect().height;
        if (h > limit) out.push({ src: img.getAttribute("src") || "", height: Math.round(h) });
      }
      return out;
    }, MAX_MEDIA_HEIGHT);
    if (oversized.length > 0) {
      errors.push(
        `${oversized.length} image(s) exceed ${MAX_MEDIA_HEIGHT}px tall, e.g. ` +
          oversized.slice(0, 3).map((o) => `${o.src} (${o.height}px)`).join(", ")
      );
    } else {
      console.log(`Media height cap: all loaded images within ${MAX_MEDIA_HEIGHT}px`);
    }
  }

  // Check: no old-style video placeholders
  const oldPlaceholders = await page.locator(".video-placeholder").count();
  if (oldPlaceholders > 0) {
    errors.push(
      `Found ${oldPlaceholders} old-style .video-placeholder elements`
    );
  }

  // Check: reply banner renders for reply posts
  const replyBanners = await page.locator(".reply-banner").count();
  console.log(`Reply banners: ${replyBanners}`);
  if (replyBanners === 0) errors.push("Reply banner not rendered for reply post");

  // Check: note embed renders (fixture data only — real data may not have notes)
  const noteEmbeds = await page.locator(".note-embed").count();
  if (!htmlPath) {
    if (noteEmbeds === 0) errors.push("No .note-embed elements rendered");
    const noteLabels = await page.locator(".note-label").count();
    if (noteLabels === 0) errors.push("No .note-label elements rendered");
  }
  console.log(`Note embeds: ${noteEmbeds}`);

  // Check: quote embed renders (fixture data only)
  const quoteEmbeds = await page.locator(".quote-embed").count();
  if (!htmlPath) {
    if (quoteEmbeds === 0) errors.push("No .quote-embed elements rendered");
    const quoteAuthors = await page.locator(".quote-author-name").count();
    if (quoteAuthors === 0) errors.push("No .quote-author-name elements rendered");
  }
  console.log(`Quote embeds: ${quoteEmbeds}`);

  // Check: search works (fixture data only — real data may not contain "alice")
  if (!htmlPath) {
    await page.fill("#search", "alice");
    await page.waitForTimeout(300);
    const filteredCount = await page.locator(".post").count();
    console.log(`Posts after search "alice": ${filteredCount}`);
    if (filteredCount === 0) errors.push("Search returned no results for 'alice'");
    if (filteredCount >= postCount)
      errors.push("Search did not filter results");
  }

  await browser.close();

  // Cleanup temp dir
  if (tempDir) {
    await rm(tempDir, { recursive: true });
  }

  // Report
  console.log("");
  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  ${w}`);
  }
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    for (const e of errors) console.log(`  ${e}`);
    process.exit(1);
  } else {
    console.log("All render checks passed.");
  }
}

const customPath = process.argv[2];
validate(customPath).catch((err) => {
  console.error("Validation failed:", err);
  process.exit(1);
});
