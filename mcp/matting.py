import sys, subprocess, os
import cv2, numpy as np
from rembg import remove, new_session

G = 'C:/Users/gupol/AppData/Roaming/video-editor-app/generated'
SRC = f'{G}/graded-match.mp4'
STUDIO = 'C:/Users/gupol/Documents/Video_Editor_App/images/studio.png'
SEG = f'{G}/_mat_seg.mp4'
SILENT = f'{G}/_mat_silent.mp4'
OUT = f'{G}/estudio-matting.mp4'

DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
MODEL = sys.argv[2] if len(sys.argv) > 2 else 'u2net_human_seg'
W, H = 1280, 720

# 1) extrai trecho
subprocess.run(['ffmpeg', '-y', '-i', SRC, '-t', str(DUR), '-an',
                '-vf', f'scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}',
                '-r', '30', SEG], check=True, capture_output=True)

# 2) fundo (cover 1280x720)
bg = cv2.imread(STUDIO)
bh, bw = bg.shape[:2]
scale = max(W / bw, H / bh)
bg = cv2.resize(bg, (int(bw * scale), int(bh * scale)))
y0 = (bg.shape[0] - H) // 2
x0 = (bg.shape[1] - W) // 2
bg = bg[y0:y0 + H, x0:x0 + W]
bg_rgb = cv2.cvtColor(bg, cv2.COLOR_BGR2RGB).astype(np.float32)

session = new_session(MODEL)
cap = cv2.VideoCapture(SEG)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
fourcc = cv2.VideoWriter_fourcc(*'mp4v')
writer = cv2.VideoWriter(SILENT, fourcc, fps, (W, H))

n = 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    cut = remove(rgb, session=session, post_process_mask=True)  # RGBA
    alpha = (cut[:, :, 3:4].astype(np.float32)) / 255.0
    fg = cut[:, :, :3].astype(np.float32)
    comp = fg * alpha + bg_rgb * (1.0 - alpha)
    writer.write(cv2.cvtColor(comp.astype(np.uint8), cv2.COLOR_RGB2BGR))
    n += 1
    if n % 15 == 0:
        print(f'   {n} frames', flush=True)

cap.release()
writer.release()
print(f'matting: {n} frames')

# 3) cola o áudio original
subprocess.run(['ffmpeg', '-y', '-i', SILENT, '-ss', '0', '-t', str(DUR), '-i', SRC,
                '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'libx264', '-crf', '20',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
                '-shortest', OUT], check=True, capture_output=True)
print('PRONTO ->', OUT)
