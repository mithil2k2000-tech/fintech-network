import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import jsQR from "jsqr";
import { Alert, AppShell, Button, Card, TextField } from "@fintech-network/design-system";
import { extractRequestKey } from "../lib/scanning";
import { NAV_ITEMS } from "../nav";

// Scanning a QR code. The camera is the main route, but it needs a secure
// context and permission, so there are always two fallbacks: take/choose a
// photo of the code, or type the short REQ- code underneath it.

type CameraState = "starting" | "scanning" | "unavailable";

export function ScanScreen() {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<CameraState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  const handleKey = useCallback(
    (raw: string) => {
      const key = extractRequestKey(raw);
      if (!key) {
        setError("That doesn't look like a payment code from this app.");
        return false;
      }
      setError(null);
      navigate(`/pay/r/${key}`);
      return true;
    },
    [navigate]
  );

  // Camera loop: grab a frame every 250ms and look for a QR in it.
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCamera("unavailable");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setCamera("scanning");
        timer = window.setInterval(() => {
          const canvas = canvasRef.current;
          if (!canvas || !video.videoWidth) return;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(data, width, height);
          if (found?.data && handleKey(found.data)) {
            window.clearInterval(timer);
          }
        }, 250);
      } catch {
        setCamera("unavailable");
      }
    }

    start();
    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [handleKey]);

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(data, width, height);
      if (!found?.data) {
        setError("We couldn't find a QR code in that picture.");
        return;
      }
      handleKey(found.data);
    } catch {
      setError("We couldn't read that picture.");
    }
  }

  function onManualSubmit(e: FormEvent) {
    e.preventDefault();
    handleKey(manual);
  }

  return (
    <AppShell title="Scan" nav={NAV_ITEMS}>
      <Card>
        <div
          style={{
            position: "relative",
            aspectRatio: "1 / 1",
            borderRadius: 16,
            overflow: "hidden",
            background: "var(--ds-surface-2)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <video
            ref={videoRef}
            playsInline
            muted
            aria-label="Camera preview"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: camera === "scanning" ? "block" : "none",
            }}
          />
          {camera !== "scanning" ? (
            <p className="ds-muted ds-small" style={{ padding: 16, textAlign: "center" }}>
              {camera === "starting"
                ? "Starting the camera…"
                : "The camera isn't available here. Use a photo or the code instead."}
            </p>
          ) : null}
        </div>
        <canvas ref={canvasRef} style={{ display: "none" }} />
        <p className="ds-muted ds-small" style={{ textAlign: "center", marginTop: 12 }}>
          Point the camera at a payment QR code.
        </p>
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <label className="ds-button ds-button--secondary ds-button--block">
        Use a photo of the code
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPhoto}
          data-testid="qr-photo-input"
          className="ds-visually-hidden"
        />
      </label>

      <form className="ds-stack" onSubmit={onManualSubmit}>
        <TextField
          label="Or enter the code"
          placeholder="REQ-XXXXXXXX"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <Button type="submit" variant="secondary" block disabled={manual.trim().length === 0}>
          Continue
        </Button>
      </form>
    </AppShell>
  );
}
