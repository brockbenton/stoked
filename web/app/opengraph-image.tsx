import { PREVIEW_SIZE, previewImage } from "@/components/preview-image";

/** The preview for the app's own link. Gift links have their own, under g/[id]. */
export const alt = "Stoked. Send a stock gift.";
export const size = PREVIEW_SIZE;
export const contentType = "image/png";

export default function Image() {
  return previewImage("Send a stock gift", "Pick a stock, add a note, send the link");
}
