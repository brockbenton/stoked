import { ImageResponse } from "next/og";

/** The 1200x630 link preview art: a wrapped box with two lines of text. It reads no data. */
export const PREVIEW_SIZE = { width: 1200, height: 630 };

const GREEN = "#12372A";
const GOLD = "#E8B33F";
const BOW = "#F2C75C";

export function previewImage(title: string, subtitle: string) {
  const loop = { position: "absolute" as const, top: 128, width: 120, height: 76, borderRadius: 60, border: `18px solid ${BOW}` };
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: GREEN, position: "relative" }}>
        <div style={{ position: "absolute", left: 270, top: 0, width: 56, height: 630, background: GOLD }} />
        <div style={{ position: "absolute", left: 0, top: 178, width: 1200, height: 56, background: GOLD }} />
        <div style={{ ...loop, left: 186, transform: "rotate(24deg)" }} />
        <div style={{ ...loop, left: 290, transform: "rotate(-24deg)" }} />
        <div style={{ position: "absolute", left: 270, top: 178, width: 56, height: 56, borderRadius: 28, background: BOW }} />
        <div
          style={{
            position: "absolute",
            left: 400,
            top: 290,
            display: "flex",
            flexDirection: "column",
            color: "#fff",
          }}
        >
          <div style={{ display: "flex", fontSize: 84 }}>{title}</div>
          <div style={{ display: "flex", fontSize: 40, marginTop: 12, color: "#DCE7E1" }}>{subtitle}</div>
          <div style={{ display: "flex", fontSize: 30, marginTop: 120, color: "#DCE7E1" }}>Stoked</div>
        </div>
      </div>
    ),
    PREVIEW_SIZE,
  );
}
