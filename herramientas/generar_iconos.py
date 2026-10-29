"""Genera los iconos PNG de la app sin librerías (PNG escrito a mano con zlib).

Uso:  python herramientas/generar_iconos.py img
"""
import struct, zlib, sys, math
out = sys.argv[1]

BG = (15, 95, 122); SUN = (242, 181, 49); CLOUD = (255, 255, 255)

def inside(x, y, maskable):
    """Color del píxel (x, y) en [0,1]², o None si es transparente."""
    if not maskable:  # cuadrado con esquinas redondeadas
        r = 0.22
        cx, cy = min(max(x, r), 1 - r), min(max(y, r), 1 - r)
        if (x - cx) ** 2 + (y - cy) ** 2 > r * r: return None
    s = 0.8 if maskable else 1.0       # en el maskable el dibujo va en la zona segura central
    u, v = (x - 0.5) / s + 0.5, (y - 0.5) / s + 0.5
    def circle(cx, cy, r): return (u - cx) ** 2 + (v - cy) ** 2 <= r * r
    cloud = circle(0.40, 0.62, 0.13) or circle(0.56, 0.53, 0.18) or circle(0.72, 0.63, 0.12) or (0.30 <= u <= 0.82 and 0.60 <= v <= 0.75)
    if cloud: return CLOUD
    if circle(0.36, 0.38, 0.15): return SUN
    # rayos del sol
    a = math.atan2(v - 0.38, u - 0.36); d = math.hypot(u - 0.36, v - 0.38)
    if 0.19 <= d <= 0.25 and abs((a / (math.pi / 4)) - round(a / (math.pi / 4))) < 0.12: return SUN
    return BG

def png(size, maskable, path):
    ss = 4  # supermuestreo 4×4 para suavizar bordes
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = inside((px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size, maskable)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            n = ss * ss; a = acc[3] // n
            if a: row += bytes([acc[0] * 255 // acc[3], acc[1] * 255 // acc[3], acc[2] * 255 // acc[3], a])
            else: row += bytes(4)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    open(path, "wb").write(data)

png(192, False, f"{out}/icon-192.png")
png(512, False, f"{out}/icon-512.png")
png(512, True, f"{out}/icon-maskable-512.png")
png(180, True, f"{out}/apple-touch-icon.png")
print("ok")
