import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findThreadItems } from "../src/scraper.js";

/** Shape of a single-post page payload: the post sits directly under `data.media`. */
function singlePostPayload(media: Record<string, unknown>) {
  return { require: [[null, null, [{ __bbox: { result: { data: { media } } } }]]] };
}

const fullPost = {
  pk: "3954534369851626047",
  id: "3954534369851626047_63423596670",
  code: "DbhVA6vFFI_",
  user: { username: "carnage4life" },
  caption: { text: "Vibe coded software is free as in puppy" },
  text_post_app_info: {},
};

describe("findThreadItems", () => {
  it("finds posts wrapped as { post: { pk } }", () => {
    const items = findThreadItems({ data: { items: [{ post: { pk: "1", code: "A" } }] } });
    assert.equal(items.length, 1);
  });

  it("finds a post exposed directly as data.media on single-post pages", () => {
    const items = findThreadItems(singlePostPayload(fullPost));
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], { post: fullPost });
  });

  it("ignores media stubs that have a pk but no code", () => {
    const stub = { pk: "3954534369851626047", id: "3954534369851626047_63423596670", user: {}, text_post_app_info: {} };
    assert.equal(findThreadItems(singlePostPayload(stub)).length, 0);
  });
});
