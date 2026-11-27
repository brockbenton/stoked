import { PREVIEW_SIZE, previewImage } from "@/components/preview-image";

/**
 * The link preview: a wrapped box and nothing else. It takes no gift id and
 * reads no data, so it can't reveal anything about a gift.
 */
export const alt = "A wrapped stock gift. Open the link to unwrap it.";
export const size = PREVIEW_SIZE;
export const contentType = "image/png";

export default function Image() {
  return previewImage("A stock gift inside", "Open the link to unwrap it");
}
