import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GalleryPost, GalleryMediaItem, GalleryQuotedPost } from "./types.js";

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns null if frontmatter is malformed.
 */
export function parseFrontmatter(
  content: string
): { meta: Record<string, string>; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const secondDelim = trimmed.indexOf("\n---\n", 3);
  const secondDelimAlt = secondDelim === -1 ? trimmed.indexOf("\n---\r\n", 3) : -1;
  const delimIdx = secondDelim !== -1 ? secondDelim : secondDelimAlt;
  if (delimIdx === -1) return null;

  const frontmatterBlock = trimmed.slice(3, delimIdx).trim();
  const delimLen = secondDelim !== -1 ? 5 : 6; // \n---\n or \n---\r\n
  const body = trimmed.slice(delimIdx + delimLen).trim();

  const meta: Record<string, string> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip surrounding double-quotes from YAML-quoted values
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n");
    }

    meta[key] = value;
  }

  return { meta, body };
}

/**
 * Extract post text and media items from the markdown body.
 * Detects image-before-video adjacency to pair thumbnails with videos.
 */
export function parseBody(body: string): { text: string; media: GalleryMediaItem[]; note?: string; quotedPost?: { author: string; verified: boolean; text: string; url: string; media: GalleryMediaItem[] } } {
  const lines = body.split("\n");
  const textLines: string[] = [];
  const noteLines: string[] = [];
  const media: GalleryMediaItem[] = [];
  let pendingImage: string | null = null;
  let pendingVideo: GalleryMediaItem | null = null;
  let inText = true;
  let inNote = false;
  let inQuote = false;

  // Quote repost state
  let quoteAuthor = "";
  let quoteVerified = false;
  const quoteTextLines: string[] = [];
  const quoteMedia: GalleryMediaItem[] = [];
  let quoteUrl = "";

  const imageRegex = /^!\[.*?\]\(([^)]+)\)$/;
  const videoRegex = /^\[Video\]\(([^)]+)\)$/;
  const noteStartRegex = /^>\s*\[!note\]/;
  const quoteStartRegex = /^>\s*\[!quote\]\s*(.+)/;

  for (const line of lines) {
    const trimmed = line.trim();

    // Stop at footer separator
    if (trimmed === "---" && (textLines.length > 0 || media.length > 0 || noteLines.length > 0 || quoteAuthor)) {
      if (pendingImage) {
        media.push({ type: "image", src: pendingImage });
        pendingImage = null;
      }
      break;
    }

    // Note callout detection
    if (noteStartRegex.test(trimmed)) {
      inNote = true;
      inText = false;
      continue;
    }
    if (inNote) {
      if (trimmed.startsWith("> ")) {
        noteLines.push(trimmed.slice(2));
        continue;
      } else if (trimmed === ">") {
        noteLines.push("");
        continue;
      } else {
        inNote = false;
      }
    }

    // Quote callout detection
    const quoteMatch = trimmed.match(quoteStartRegex);
    if (quoteMatch) {
      inQuote = true;
      inText = false;
      const authorStr = quoteMatch[1].trim();
      if (authorStr.endsWith(" \u2713")) {
        quoteAuthor = authorStr.slice(0, -2);
        quoteVerified = true;
      } else {
        quoteAuthor = authorStr;
        quoteVerified = false;
      }
      continue;
    }
    if (inQuote) {
      if (trimmed.startsWith("> ")) {
        const inner = trimmed.slice(2);
        const qImg = inner.match(imageRegex);
        const qVid = inner.match(videoRegex);
        const qLink = inner.match(/^\[View quoted post\]\(([^)]+)\)$/);
        if (qImg) {
          quoteMedia.push({ type: "image", src: qImg[1] });
        } else if (qVid) {
          quoteMedia.push({ type: "video", src: qVid[1] });
        } else if (qLink) {
          quoteUrl = qLink[1];
        } else {
          quoteTextLines.push(inner);
        }
        continue;
      } else if (trimmed === ">") {
        quoteTextLines.push("");
        continue;
      } else {
        inQuote = false;
      }
    }

    const imgMatch = trimmed.match(imageRegex);
    const vidMatch = trimmed.match(videoRegex);

    if (imgMatch) {
      inText = false;
      if (pendingVideo) {
        // Video immediately before image = video-thumbnail pair. The parser
        // emits video-first when it falls through to recursive media search,
        // which would otherwise leave an orphaned thumbnail below the video.
        pendingVideo.poster = imgMatch[1];
        pendingVideo = null;
      } else {
        // Flush any previously pending image as a standalone image
        if (pendingImage) {
          media.push({ type: "image", src: pendingImage });
        }
        pendingImage = imgMatch[1];
      }
    } else if (vidMatch) {
      inText = false;
      pendingVideo = null;
      if (pendingImage) {
        // Image immediately before video = thumbnail-video pair
        media.push({ type: "video", src: vidMatch[1], poster: pendingImage });
        pendingImage = null;
      } else {
        pendingVideo = { type: "video", src: vidMatch[1] };
        media.push(pendingVideo);
      }
    } else if (inText) {
      textLines.push(line);
    }
  }

  // Flush any remaining pending image
  if (pendingImage) {
    media.push({ type: "image", src: pendingImage });
  }

  const note = noteLines.length > 0 ? noteLines.join("\n").trim() : undefined;
  const quotedPost = quoteAuthor
    ? { author: quoteAuthor, verified: quoteVerified, text: quoteTextLines.join("\n").trim(), url: quoteUrl, media: quoteMedia }
    : undefined;
  return { text: textLines.join("\n").trim(), media, note, quotedPost };
}

/**
 * Scan the assets directory and group image files by post ID.
 */
async function scanAssets(assetsDir: string): Promise<{ postImages: Map<string, string[]>; quotedImages: Map<string, string[]>; profilePics: Map<string, string> }> {
  const postImages = new Map<string, string[]>();
  const quotedImages = new Map<string, string[]>();
  const emptyResult = { postImages, quotedImages, profilePics: new Map<string, string>() };
  if (!existsSync(assetsDir)) return emptyResult;

  const files = await readdir(assetsDir);
  const imageRegex = /^(\d+)-(q?)(\d+)\.(jpe?g|png|webp|gif)$/i;

  for (const file of files) {
    const m = imageRegex.exec(file);
    if (!m) continue;

    const postId = m[1];
    const isQuoted = m[2] === "q";
    const targetMap = isQuoted ? quotedImages : postImages;
    const existing = targetMap.get(postId) || [];
    existing.push(`assets/${file}`);
    targetMap.set(postId, existing);
  }

  // Sort each array by the numeric index
  for (const map of [postImages, quotedImages]) {
    for (const [, paths] of map) {
      paths.sort((a, b) => {
        const idxA = parseInt(a.match(/-q?(\d+)\.[^.]+$/)?.[1] || "0", 10);
        const idxB = parseInt(b.match(/-q?(\d+)\.[^.]+$/)?.[1] || "0", 10);
        return idxA - idxB;
      });
    }
  }

  const profilePics = scanProfilePics(files);

  return { postImages, quotedImages, profilePics };
}

/**
 * Scan the assets directory for profile picture files.
 * Returns a map of @username -> relative path.
 */
function scanProfilePics(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const profileRegex = /^(.+)-profile\.(jpe?g|png|webp|gif)$/i;

  for (const file of files) {
    const m = profileRegex.exec(file);
    if (!m) continue;
    const username = m[1];
    map.set(`@${username}`, `assets/${file}`);
  }

  return map;
}

/**
 * Read all markdown files and build GalleryPost objects.
 */
async function readAllPosts(
  postsDir: string,
  assetMap: Map<string, string[]>,
  quotedAssetMap: Map<string, string[]>,
  profilePicMap: Map<string, string>
): Promise<GalleryPost[]> {
  const files = await readdir(postsDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const posts: GalleryPost[] = [];

  for (const file of mdFiles) {
    const content = await readFile(join(postsDir, file), "utf-8");
    const parsed = parseFrontmatter(content);

    if (!parsed) {
      console.warn(`Skipping malformed file: ${file}`);
      continue;
    }

    const { meta, body } = parsed;
    const { text, media: parsedMedia, note, quotedPost: parsedQuote } = parseBody(body);

    // Use parsed media from body; fall back to asset map if body had no images
    // (but skip fallback when a quoted post exists — the body is authoritative
    // and the outer post genuinely has no media of its own)
    let media = parsedMedia;
    if (media.length === 0 && !parsedQuote) {
      const fallbackImages = assetMap.get(meta.id) || [];
      media = fallbackImages.map((src) => ({ type: "image" as const, src }));
    }

    const author = meta.author || "@unknown";

    // Build quoted post from parsed body + frontmatter metadata
    let quotedPost: GalleryQuotedPost | undefined;
    if (parsedQuote) {
      const qAuthor = parsedQuote.author || meta.quoted_author || "@unknown";
      let qMedia = parsedQuote.media;
      if (qMedia.length === 0) {
        const fallbackQuoted = quotedAssetMap.get(meta.id) || [];
        qMedia = fallbackQuoted.map((src) => ({ type: "image" as const, src }));
      }
      quotedPost = {
        author: qAuthor,
        verified: parsedQuote.verified || meta.quoted_verified === "true",
        avatar: profilePicMap.get(qAuthor),
        text: parsedQuote.text,
        url: parsedQuote.url || meta.quoted_url || "",
        media: qMedia,
      };
    }

    posts.push({
      id: meta.id || "",
      author,
      verified: meta.verified === "true",
      avatar: profilePicMap.get(author),
      date: meta.date || "",
      url: meta.url || "",
      likes: parseInt(meta.likes, 10) || 0,
      replies: parseInt(meta.replies, 10) || 0,
      reposts: parseInt(meta.reposts, 10) || 0,
      text,
      note,
      media,
      quotedPost,
      isReply: meta.isReply === "true" || undefined,
      replyToAuthor: meta.replyToAuthor || undefined,
    });
  }

  // Sort newest first
  posts.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  return posts;
}

/**
 * Generate the self-contained HTML gallery.
 */
export function generateHtml(posts: GalleryPost[]): string {
  // Escape </ sequences to prevent </script> from breaking out of the script block
  const postsJson = JSON.stringify(posts).replace(/<\//g, "<\\/");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Threadsafe</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='5 3 22 14.5'%3E%3Crect x='6' y='4' width='20' height='3' rx='1.5' fill='white'/%3E%3Crect x='10' y='7' width='12' height='8' fill='white'/%3E%3Crect x='6' y='15' width='20' height='3' rx='1.5' fill='white'/%3E%3Crect x='14' y='5' width='4' height='7' rx='1' fill='%230095f6'/%3E%3Cpolygon points='11,11 16,16.5 21,11' fill='%230095f6'/%3E%3C/svg%3E">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#000;--surface:#181818;--border:#2d2d2d;--hover:#222;
  --text:#f5f5f5;--text2:#999;--text3:#666;--accent:#0095f6;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
body{background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.4}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

/* Header */
.header{
  position:sticky;top:0;z-index:100;
  background:var(--bg);border-bottom:1px solid var(--border);
  padding:12px 16px;
}
.header-inner{
  max-width:960px;margin:0 auto;
  display:flex;align-items:center;gap:12px;flex-wrap:wrap;
}
.logo{font-weight:700;font-size:18px;margin-right:auto;letter-spacing:-.3px}
.logo span{font-weight:400;color:var(--text2);font-size:14px;margin-left:8px}
.search{
  background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:8px 12px;color:var(--text);font-size:14px;width:220px;
  font-family:var(--font);outline:none;
}
.search:focus{border-color:var(--accent)}
.search::placeholder{color:var(--text3)}
select{
  background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:8px 12px;color:var(--text2);font-size:14px;
  font-family:var(--font);outline:none;cursor:pointer;
  -webkit-appearance:none;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23999' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 10px center;
  padding-right:28px;
}
.stats{text-align:center;color:var(--text3);font-size:13px;padding:10px 0}

/* Feed */
#feed{max-width:600px;margin:0 auto;padding:8px 0}
.post{border-bottom:1px solid var(--border);padding:16px}
.post:hover{background:var(--hover)}
.post .author-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.avatar{
  width:40px;height:40px;border-radius:50%;background:#333;
  display:flex;align-items:center;justify-content:center;
  font-weight:600;font-size:16px;flex-shrink:0;color:#fff;
}
img.avatar{object-fit:cover}
.author-name{font-weight:600;font-size:15px}
.verified{display:inline-flex;margin-left:4px;vertical-align:middle}
.date{color:var(--text2);font-size:14px;margin-left:auto}
.post-text{font-size:15px;line-height:1.5;white-space:pre-wrap;margin-bottom:12px;word-break:break-word}
.post-text a{color:#0095f6;text-decoration:none}
.post-text a:hover{text-decoration:underline}
/* Media */
.media{margin-bottom:8px}
.post-img{max-width:100%;border-radius:8px;display:block;cursor:zoom-in}
.post-video{max-width:100%;border-radius:8px;display:block;background:#000}
.video-container{position:relative;cursor:pointer}
.video-container .post-img{cursor:pointer}
.play-overlay{
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.3);border-radius:8px;transition:background .15s;
}
.video-container:hover .play-overlay{background:rgba(0,0,0,.15)}

/* Single media: cap height so the post always fits on screen */
.media-single{display:flex;justify-content:center}
.media-single .post-img,
.media-single .post-video{
  max-width:100%;max-height:min(70vh,640px);
  width:auto;height:auto;
}
.media-single .video-container{width:fit-content;max-width:100%}

/* Carousel: uniform height, natural widths, scrolls sideways */
.media-carousel{position:relative}
.media-frame{position:relative}
.media-track{
  position:relative;
  display:flex;gap:4px;overflow-x:auto;overscroll-behavior-x:contain;
  scroll-snap-type:x mandatory;scrollbar-width:none;border-radius:8px;
}
.media-track::-webkit-scrollbar{display:none}
.media-track > *{flex:0 0 auto;scroll-snap-align:center}
.media-track .post-img,
.media-track .post-video{
  height:min(45vh,360px);width:auto;max-width:100%;
}
.media-track .video-container{width:fit-content;max-width:100%}

/* Carousel controls */
.media-nav{
  position:absolute;top:50%;transform:translateY(-50%);z-index:2;
  width:32px;height:32px;border:none;border-radius:50%;
  background:rgba(0,0,0,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  color:#fff;font-size:18px;line-height:1;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity .15s,background .15s;
}
.media-carousel:hover .media-nav{opacity:1}
.media-nav:hover{background:rgba(0,0,0,.75)}
.media-nav.prev{left:8px}
.media-nav.next{right:8px}
.media-nav[disabled]{opacity:0!important;pointer-events:none}
@media(hover:none){.media-nav{display:none}}
.media-dots{display:flex;justify-content:center;gap:6px;margin-top:8px}
.media-dot{
  width:6px;height:6px;border-radius:50%;
  background:var(--text3);opacity:.4;transition:opacity .15s;
}
.media-dot.active{opacity:1;background:var(--accent)}
.media-count{
  position:absolute;top:8px;right:8px;z-index:2;
  padding:3px 8px;border-radius:12px;
  background:rgba(0,0,0,.6);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  color:#fff;font-size:12px;font-variant-numeric:tabular-nums;pointer-events:none;
}
.metrics{display:flex;gap:16px;font-size:14px;color:var(--text2);margin-top:8px}
.actions{display:flex;gap:16px;margin-top:8px;font-size:13px}
.note-embed{
  background:var(--surface);border:1px solid var(--border);
  border-radius:12px;padding:14px 16px;margin:8px 0 12px;
}
.note-label{
  font-size:11px;font-weight:600;color:var(--accent);
  text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;
}
.note-text{font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text2)}
.quote-embed{
  background:var(--surface);border:1px solid var(--border);
  border-left:3px solid var(--accent);
  border-radius:12px;padding:14px 16px;margin:8px 0 12px;
}
.quote-author-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.quote-avatar{
  width:24px;height:24px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-weight:600;font-size:11px;flex-shrink:0;color:#fff;
}
img.quote-avatar{object-fit:cover}
.quote-author-name{font-weight:600;font-size:13px}
.quote-text{font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--text2)}
.quote-media{margin-top:8px}
.quote-media .media{margin-bottom:0}
.quote-media .post-img,
.quote-media .post-video{border-radius:6px}
.quote-media .media-single .post-img,
.quote-media .media-single .post-video{max-height:320px}
.quote-media .media-track .post-img,
.quote-media .media-track .post-video{height:200px}
.quote-link{font-size:12px;color:var(--text3);margin-top:8px;display:inline-block}
.quote-link:hover{color:var(--text)}
.actions a,.actions button{
  color:var(--text3);background:none;border:none;font-size:13px;
  font-family:var(--font);cursor:pointer;padding:0;
}
.actions a:hover,.actions button:hover{color:var(--text)}

/* Reply indicator */
.reply-banner{
  display:flex;align-items:center;gap:6px;
  padding:8px 12px;margin-bottom:10px;
  border-left:3px solid var(--accent);
  background:rgba(0,149,246,.06);border-radius:0 8px 8px 0;
  font-size:13px;color:var(--text2);
}
.reply-banner .reply-icon{flex-shrink:0;opacity:.6}
.reply-banner .reply-author{color:var(--accent);font-weight:600}

.sentinel{padding:40px;text-align:center}

/* Scroll to top */
.scroll-top{
  position:fixed;bottom:24px;right:24px;z-index:150;
  width:40px;height:40px;border-radius:50%;border:none;
  background:rgba(255,255,255,.15);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  color:#fff;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  opacity:0;transform:translateY(12px);
  transition:opacity .25s,transform .25s,background .15s;
  pointer-events:none;
}
.scroll-top.visible{opacity:1;transform:translateY(0);pointer-events:auto}
.scroll-top:hover{background:rgba(255,255,255,.25);transform:scale(1.1)}
.scroll-top:active{transform:scale(.95)}

/* Lightbox */
.lightbox{
  position:fixed;inset:0;z-index:200;
  background:rgba(0,0,0,.94);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  display:none;align-items:center;justify-content:center;
}
.lightbox.open{display:flex}
.lightbox-img{
  max-width:92vw;max-height:92vh;object-fit:contain;
  border-radius:4px;user-select:none;
}
.lightbox-close,.lightbox-nav{
  position:absolute;z-index:2;border:none;cursor:pointer;
  background:rgba(255,255,255,.12);color:#fff;
  display:flex;align-items:center;justify-content:center;
  transition:background .15s;
}
.lightbox-close:hover,.lightbox-nav:hover{background:rgba(255,255,255,.25)}
.lightbox-close{
  top:20px;right:20px;width:40px;height:40px;
  border-radius:50%;font-size:22px;line-height:1;
}
.lightbox-nav{
  top:50%;transform:translateY(-50%);
  width:48px;height:48px;border-radius:50%;font-size:26px;line-height:1;
}
.lightbox-nav.prev{left:20px}
.lightbox-nav.next{right:20px}
.lightbox-nav[disabled]{opacity:.25;pointer-events:none}
.lightbox-count{
  position:absolute;bottom:24px;left:50%;transform:translateX(-50%);
  color:#fff;font-size:13px;font-variant-numeric:tabular-nums;
  background:rgba(0,0,0,.5);padding:4px 12px;border-radius:12px;
}

/* Responsive */
@media(max-width:720px){
  .header-inner{gap:8px}
  .search{width:160px}
  .media-single .post-img,
  .media-single .post-video{max-height:min(60vh,480px)}
  .media-track .post-img,
  .media-track .post-video{height:min(40vh,260px)}
  .lightbox-nav{width:40px;height:40px;font-size:22px}
  .lightbox-nav.prev{left:8px}
  .lightbox-nav.next{right:8px}
}
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <div class="logo">Threadsafe <span id="postCount"></span></div>
    <input class="search" id="search" type="text" placeholder="Search posts...">
    <select id="authorFilter"></select>
    <select id="sortMode">
      <option value="newest">Newest</option>
      <option value="most-liked">Most liked</option>
      <option value="oldest">Oldest</option>
    </select>
  </div>
</div>
<div class="stats" id="stats"></div>
<div id="feed"></div>

<button class="scroll-top" id="scrollTop" aria-label="Scroll to top" onclick="scrollToTop()">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
</button>

<div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="Image viewer">
  <button class="lightbox-close" id="lightboxClose" aria-label="Close">&times;</button>
  <button class="lightbox-nav prev" id="lightboxPrev" aria-label="Previous image">&#8249;</button>
  <img class="lightbox-img" id="lightboxImg" alt="">
  <button class="lightbox-nav next" id="lightboxNext" aria-label="Next image">&#8250;</button>
  <div class="lightbox-count" id="lightboxCount"></div>
</div>

<script>
const POSTS=` + postsJson + `;
const BATCH=50;
const DOTS_MAX=8;
let searchQuery="";
let authorFilter="";
let sortMode="newest";
let filtered=[];
let rendered=0;
let debounceTimer=null;

const verifiedSvg='<svg class="verified" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#0095f6"/><path d="M6.8 11.2L4 8.4l1-1 1.8 1.8 4.2-4.2 1 1z" fill="#fff"/></svg>';
const playSvg='<svg width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="23" fill="none" stroke="#fff" stroke-width="2" opacity=".7"/><polygon points="20,16 34,24 20,32" fill="#fff" opacity=".7"/></svg>';

function stripAt(a){return a.replace(/^@/,"")}
function esc(s){
  if(!s)return"";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function linkify(s){
  if(!s)return"";
  var t=esc(s);
  return t.replace(/https?:\\/\\/[^\\s)&]+(?:&amp;[^\\s)&]+)*/g,function(url){
    url=url.replace(/[.,;:!]+$/,"");
    var href=url.replace(/&amp;/g,"&");
    return '<a href="'+href+'" target="_blank" rel="noopener">'+url+'<\\/a>';
  });
}
function fmtDate(d){
  try{var dt=new Date(d);return dt.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
  catch(e){return d}
}
function fmtNum(n){return n>=1000?(n/1000).toFixed(n>=10000?0:1)+"k":String(n)}

function avatarColor(name){
  var h=0;for(var i=0;i<name.length;i++)h=name.charCodeAt(i)+((h<<5)-h);
  return "hsl("+(Math.abs(h)%360)+",45%,40%)";
}

function init(){
  var counts=new Map();
  for(var i=0;i<POSTS.length;i++){
    var a=POSTS[i].author;
    counts.set(a,(counts.get(a)||0)+1);
  }
  var sorted=Array.from(counts.entries()).sort(function(a,b){return b[1]-a[1]});
  var sel=document.getElementById("authorFilter");
  sel.innerHTML='<option value="">All authors ('+sorted.length+')</option>';
  for(var j=0;j<sorted.length;j++){
    var pair=sorted[j];
    sel.innerHTML+='<option value="'+esc(pair[0])+'">'+esc(stripAt(pair[0]))+" ("+pair[1]+")</option>";
  }

  document.getElementById("search").addEventListener("input",function(){
    clearTimeout(debounceTimer);
    var self=this;
    debounceTimer=setTimeout(function(){searchQuery=self.value.toLowerCase();applyFilters()},150);
  });
  sel.addEventListener("change",function(){authorFilter=this.value;applyFilters()});
  document.getElementById("sortMode").addEventListener("change",function(){sortMode=this.value;applyFilters()});

  applyFilters();
}

function applyFilters(){
  filtered=POSTS.filter(function(p){
    if(authorFilter&&p.author!==authorFilter)return false;
    if(searchQuery){
      var haystack=p.text.toLowerCase()+" "+p.author.toLowerCase()+(p.note?" "+p.note.toLowerCase():"")+(p.quotedPost?" "+p.quotedPost.text.toLowerCase()+" "+p.quotedPost.author.toLowerCase():"");
      if(haystack.indexOf(searchQuery)===-1)return false;
    }
    return true;
  });
  if(sortMode==="newest")filtered.sort(function(a,b){return new Date(b.date)-new Date(a.date)});
  else if(sortMode==="oldest")filtered.sort(function(a,b){return new Date(a.date)-new Date(b.date)});
  else if(sortMode==="most-liked")filtered.sort(function(a,b){return b.likes-a.likes});

  document.getElementById("stats").textContent="Showing "+filtered.length+" of "+POSTS.length+" posts";
  document.getElementById("postCount").textContent=filtered.length+" posts";

  var feed=document.getElementById("feed");
  feed.innerHTML="";
  rendered=0;
  renderBatch();
}

function renderBatch(){
  var feed=document.getElementById("feed");
  var batch=filtered.slice(rendered,rendered+BATCH);
  for(var i=0;i<batch.length;i++){
    feed.insertAdjacentHTML("beforeend",renderPost(batch[i]));
  }
  rendered+=batch.length;
  if(rendered<filtered.length){
    var sentinel=document.createElement("div");
    sentinel.className="sentinel";
    sentinel.textContent="Loading more...";
    feed.appendChild(sentinel);
    var obs=new IntersectionObserver(function(entries){
      if(entries[0].isIntersecting){obs.disconnect();sentinel.remove();renderBatch()}
    },{rootMargin:"200px"});
    obs.observe(sentinel);
  }
}

function renderMediaItemHtml(m,idx){
  if(m.type==="image"){
    return '<img class="post-img" src="'+esc(m.src)+'" data-idx="'+idx+'" loading="lazy" alt="">';
  }
  if(m.poster){
    return '<div class="video-container" data-video="'+esc(m.src)+'" onclick="playVideo(event,this)">'
      +'<img class="post-img" src="'+esc(m.poster)+'" data-idx="'+idx+'" loading="lazy" alt="">'
      +'<div class="play-overlay">'+playSvg+'</div></div>';
  }
  return '<video class="post-video" data-idx="'+idx+'" controls playsinline preload="metadata">'
    +'<source src="'+esc(m.src)+'" type="video/mp4"></video>';
}

function renderMediaHtml(media){
  if(!media||media.length===0)return"";
  var i;
  if(media.length===1){
    return '<div class="media media-single">'+renderMediaItemHtml(media[0],0)+'</div>';
  }
  var items="";
  for(i=0;i<media.length;i++)items+=renderMediaItemHtml(media[i],i);
  var indicator;
  if(media.length>DOTS_MAX){
    indicator='<div class="media-count">1 / '+media.length+'</div>';
  }else{
    var dots="";
    for(i=0;i<media.length;i++)dots+='<span class="media-dot'+(i===0?" active":"")+'"></span>';
    indicator='<div class="media-dots">'+dots+'</div>';
  }
  return '<div class="media media-carousel">'
    +'<div class="media-frame">'
    +'<div class="media-track">'+items+'</div>'
    +'<button class="media-nav prev" aria-label="Previous image" disabled>&#8249;</button>'
    +'<button class="media-nav next" aria-label="Next image">&#8250;</button>'
    +(media.length>DOTS_MAX?indicator:'')
    +'</div>'
    +(media.length>DOTS_MAX?'':indicator)
    +'</div>';
}

function carouselIndex(track){
  var items=track.children;
  var center=track.scrollLeft+track.clientWidth/2;
  var best=0,bestDist=Infinity;
  for(var i=0;i<items.length;i++){
    var mid=items[i].offsetLeft+items[i].offsetWidth/2;
    var d=Math.abs(mid-center);
    if(d<bestDist){bestDist=d;best=i}
  }
  return best;
}

function updateCarousel(track){
  var carousel=track.closest(".media-carousel");
  if(!carousel)return;
  var idx=carouselIndex(track);
  var dots=carousel.querySelectorAll(".media-dot");
  for(var i=0;i<dots.length;i++)dots[i].classList.toggle("active",i===idx);
  var count=carousel.querySelector(".media-count");
  if(count)count.textContent=(idx+1)+" / "+track.children.length;
  var prev=carousel.querySelector(".media-nav.prev");
  var next=carousel.querySelector(".media-nav.next");
  if(prev)prev.disabled=track.scrollLeft<=1;
  if(next)next.disabled=track.scrollLeft+track.clientWidth>=track.scrollWidth-1;
}

function avatarFallbackHtml(author){
  var initial=stripAt(author).charAt(0).toUpperCase();
  var color=avatarColor(author);
  return '<div class="avatar" style="background:'+color+'">'+initial+'</div>';
}

function handleAvatarError(el){
  el.outerHTML=avatarFallbackHtml(el.dataset.author);
}

function renderAvatarHtml(p){
  if(p.avatar)return '<img class="avatar" src="'+esc(p.avatar)+'" loading="lazy" alt="" data-author="'+esc(p.author)+'" onerror="handleAvatarError(this)">';
  return avatarFallbackHtml(p.author);
}

function renderNoteHtml(p){
  if(!p.note)return"";
  return '<div class="note-embed"><div class="note-label">Note</div>'
    +'<div class="note-text">'+linkify(p.note)+'</div></div>';
}

function renderQuoteHtml(p){
  if(!p.quotedPost)return"";
  var q=p.quotedPost;
  var qAuthor=esc(stripAt(q.author));
  var qBadge=q.verified?verifiedSvg:"";
  var avatarHtml;
  if(q.avatar){
    avatarHtml='<img class="quote-avatar" src="'+esc(q.avatar)+'" loading="lazy" alt="">';
  }else{
    var initial=stripAt(q.author).charAt(0).toUpperCase();
    avatarHtml='<div class="quote-avatar" style="background:'+avatarColor(q.author)+'">'+initial+'</div>';
  }
  var mediaHtml="";
  if(q.media&&q.media.length>0){
    mediaHtml='<div class="quote-media">'+renderMediaHtml(q.media)+'</div>';
  }
  var linkHtml=q.url?'<a class="quote-link" href="'+esc(q.url)+'" target="_blank" rel="noopener">View on Threads &#8599;</a>':"";
  return '<div class="quote-embed">'
    +'<div class="quote-author-row">'+avatarHtml
    +'<span class="quote-author-name">'+qAuthor+'</span>'+qBadge+'</div>'
    +(q.text?'<div class="quote-text">'+linkify(q.text)+'</div>':'')
    +mediaHtml+linkHtml+'</div>';
}

var replySvg='<svg class="reply-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17l-5-5 5-5"/><path d="M4 12h11a4 4 0 0 1 0 8h-1"/></svg>';

function renderReplyBanner(p){
  if(!p.isReply)return"";
  var label=p.replyToAuthor?"Replying to <span class=\\"reply-author\\">"+esc(stripAt(p.replyToAuthor))+"</span>":"Reply to another post";
  return '<div class="reply-banner">'+replySvg+' '+label+'</div>';
}

function renderPost(p){
  var author=esc(stripAt(p.author));
  var vBadge=p.verified?verifiedSvg:"";
  var dateStr=fmtDate(p.date);

  return '<div class="post">'
    +'<div class="author-row">'
    +renderAvatarHtml(p)
    +'<div><span class="author-name">'+author+'</span>'+vBadge+'</div>'
    +'<span class="date">'+esc(dateStr)+'</span></div>'
    +renderReplyBanner(p)
    +(p.text?'<div class="post-text">'+linkify(p.text)+'</div>':'')
    +renderNoteHtml(p)
    +renderQuoteHtml(p)
    +renderMediaHtml(p.media)
    +'<div class="metrics"><span>&#10084; '+fmtNum(p.likes)+'</span><span>&#128172; '+fmtNum(p.replies)+'</span><span>&#128260; '+fmtNum(p.reposts)+'</span></div>'
    +'<div class="actions">'
    +(p.url?'<a href="'+esc(p.url)+'" target="_blank" rel="noopener">View on Threads &#8599;</a>':'')
    +(p.url?'<button onclick="copyLink(event,this.dataset.url)" data-url="'+esc(p.url)+'">Copy link</button>':'')
    +'</div>'
    +'</div>';
}

function playVideo(e,container){
  e.stopPropagation();
  var url=container.dataset.video;
  var posterImg=container.querySelector(".post-img");
  var video=document.createElement("video");
  video.className="post-video";
  video.controls=true;
  video.playsInline=true;
  video.autoplay=true;
  // Carry the poster over so swapping in the video keeps the same box instead
  // of jumping to the video's intrinsic size against a black background.
  if(posterImg){
    var posterSrc=posterImg.getAttribute("src");
    if(posterSrc)video.setAttribute("poster",posterSrc);
    if(posterImg.dataset.idx)video.dataset.idx=posterImg.dataset.idx;
  }
  var source=document.createElement("source");
  source.src=url;
  source.type="video/mp4";
  video.appendChild(source);
  container.replaceWith(video);
  video.addEventListener("error",function(){
    var msg=document.createElement("div");
    msg.style.cssText="padding:20px;text-align:center;color:var(--text2);font-size:13px";
    msg.textContent="Video unavailable";
    video.replaceWith(msg);
  });
}

function copyLink(e,url){
  e.stopPropagation();
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(function(){
      var btn=e.target;
      var orig=btn.textContent;
      btn.textContent="Copied!";
      setTimeout(function(){btn.textContent=orig},1500);
    }).catch(function(){});
  }
}

var lbItems=[],lbIndex=0;

function openLightbox(img){
  var container=img.closest(".media");
  var imgs=container?container.querySelectorAll(".post-img"):[img];
  lbItems=[];
  var start=0;
  for(var i=0;i<imgs.length;i++){
    // Video posters stay click-to-play; only real images enter the lightbox.
    if(imgs[i].closest(".video-container"))continue;
    if(imgs[i]===img)start=lbItems.length;
    lbItems.push(imgs[i].getAttribute("src"));
  }
  if(lbItems.length===0)return;
  lbIndex=start;
  document.getElementById("lightbox").classList.add("open");
  document.body.style.overflow="hidden";
  renderLightbox();
}

function renderLightbox(){
  var multi=lbItems.length>1;
  document.getElementById("lightboxImg").src=lbItems[lbIndex];
  document.getElementById("lightboxCount").textContent=multi?(lbIndex+1)+" / "+lbItems.length:"";
  var prev=document.getElementById("lightboxPrev");
  var next=document.getElementById("lightboxNext");
  prev.style.display=multi?"":"none";
  next.style.display=multi?"":"none";
  prev.disabled=lbIndex===0;
  next.disabled=lbIndex===lbItems.length-1;
}

function closeLightbox(){
  document.getElementById("lightbox").classList.remove("open");
  document.getElementById("lightboxImg").removeAttribute("src");
  document.body.style.overflow="";
  lbItems=[];
}

function lightboxStep(n){
  var next=lbIndex+n;
  if(next<0||next>=lbItems.length)return;
  lbIndex=next;
  renderLightbox();
}

// Delegated listeners: the feed re-renders in batches, so per-element wiring
// would need to be redone on every batch.
(function(){
  var scrollRaf=null;
  document.addEventListener("scroll",function(e){
    var t=e.target;
    if(!t||!t.classList||!t.classList.contains("media-track"))return;
    if(scrollRaf)return;
    scrollRaf=requestAnimationFrame(function(){scrollRaf=null;updateCarousel(t)});
  },true);

  document.addEventListener("click",function(e){
    if(!e.target||!e.target.closest)return;
    var nav=e.target.closest(".media-nav");
    if(nav){
      var track=nav.parentElement.querySelector(".media-track");
      if(track){
        var delta=Math.max(track.clientWidth*0.8,120);
        track.scrollBy({left:nav.classList.contains("next")?delta:-delta,behavior:"smooth"});
      }
      return;
    }
    var img=e.target.closest(".post-img");
    if(img&&!img.closest(".video-container"))openLightbox(img);
  });

  var lb=document.getElementById("lightbox");
  if(!lb)return;
  document.getElementById("lightboxClose").addEventListener("click",closeLightbox);
  document.getElementById("lightboxPrev").addEventListener("click",function(){lightboxStep(-1)});
  document.getElementById("lightboxNext").addEventListener("click",function(){lightboxStep(1)});
  lb.addEventListener("click",function(e){if(e.target===lb)closeLightbox()});
  document.addEventListener("keydown",function(e){
    if(!lb.classList.contains("open"))return;
    var tag=document.activeElement?document.activeElement.tagName:"";
    if(tag==="INPUT"||tag==="SELECT"||tag==="TEXTAREA")return;
    if(e.key==="Escape")closeLightbox();
    else if(e.key==="ArrowLeft")lightboxStep(-1);
    else if(e.key==="ArrowRight")lightboxStep(1);
  });
})();

function scrollToTop(){
  window.scrollTo({top:0,behavior:"smooth"});
}
(function(){
  var btn=document.getElementById("scrollTop");
  if(!btn)return;
  window.addEventListener("scroll",function(){
    btn.classList.toggle("visible",window.scrollY>400);
  },{passive:true});
})();

document.addEventListener("DOMContentLoaded",init);
</script>
</body>
</html>`;
}

/**
 * Generate the gallery HTML file from all backed-up posts.
 */
export async function generateGallery(outputDir: string): Promise<void> {
  console.log("\nGenerating gallery...");

  const postsDir = join(outputDir, "posts");
  const assetsDir = join(outputDir, "assets");

  if (!existsSync(postsDir)) {
    console.log("No posts directory found, skipping gallery generation.");
    return;
  }

  const { postImages, quotedImages, profilePics } = await scanAssets(assetsDir);
  const posts = await readAllPosts(postsDir, postImages, quotedImages, profilePics);

  if (posts.length === 0) {
    console.log("No posts found, skipping gallery generation.");
    return;
  }

  const html = generateHtml(posts);
  await writeFile(join(outputDir, "index.html"), html, "utf-8");
  console.log(
    `Gallery generated: ${join(outputDir, "index.html")} (${posts.length} posts)`
  );
}
