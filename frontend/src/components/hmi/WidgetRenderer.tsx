import React from "react";
import { motion } from "framer-motion";
import { PowerIcon } from "lucide-react";
import { HmiWidget } from "../../models/widget";
import { PlcVariable } from "../../models/plc";
import { formatValue, valueFraction, isTruthy } from "../../utils/format";
import { customByKind, zipByKind } from "./custom/registry";
import { estiloDeParte } from "./partes";
import { HtmlWidgetRenderer } from "./HtmlWidgetRenderer";
import { leerConfigImagen } from "./inspectores";

interface Props {
  widget: HmiWidget;
  variable?: PlcVariable;
  live?: boolean; // whether values animate (Designer preview always live)
}

// Pure visual renderer for a single HMI widget. Reused by canvas + preview.
export function WidgetRenderer({ widget, variable }: Props) {
  const { style } = widget;
  const frac = valueFraction(variable);
  const on = isTruthy(variable);
  const label = variable ? formatValue(variable) : widget.text;
  // Estilo de cada parte: la base del `style` de siempre con lo que se haya
  // ajustado por parte encima. Un widget sin ajustes se ve exactamente igual
  // que antes, así que ningún diseño guardado cambia de aspecto.
  const pTexto = estiloDeParte(widget, "label");
  const pCaja = estiloDeParte(widget, "box");
  const pIcono = estiloDeParte(widget, "icon");
  const pBoton = estiloDeParte(widget, "boton");
  const pValor = estiloDeParte(widget, "valor");

  const textStyle: React.CSSProperties = {
    fontSize: pTexto.fontSize,
    fontWeight: pTexto.bold ? 700 : 500,
    textAlign: pTexto.align,
    color: pTexto.color,
  };

  /** Tipografía del número de los indicadores (tanque, medidores). */
  const valorStyle: React.CSSProperties = {
    fontSize: pValor.fontSize,
    fontWeight: pValor.bold ? 700 : 500,
    color: pValor.color,
  };

  const content = () => {
    // 👇 primero checa si es custom TSX, si sí lo delega al registry
    const custom = customByKind(widget.kind);
    if (custom) {
      return custom.render({ widget, variable, style, on, frac, label });
    }

    // 👇 luego checa si es un widget HTML cargado por ZIP
    const zip = zipByKind(widget.kind);
    if (zip) {
      return <HtmlWidgetRenderer zipWidget={zip} widget={widget} variable={variable} style={style} />;
    }

    // built-in: el switch original queda intacto
    switch (widget.kind) {
      case "text":
        return (
          <div
            className="flex h-full w-full items-center px-2"
            style={{
              justifyContent: alignJustify(pTexto.align ?? style.align),
              background: pCaja.background,
              borderRadius: pCaja.borderRadius,
              border: pCaja.borderWidth
                ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
                : undefined,
            }}
          >
            <span style={textStyle} className="truncate">
              {label || "Texto"}
            </span>
          </div>
        );

      case "button":
        return (
          <div
            className="flex h-full w-full items-center justify-center shadow-sm"
            style={{
              // El fondo del botón sale de la parte «Botón». Por defecto
              // hereda `style.color`, que es lo que usaba antes.
              background: pBoton.background && pBoton.background !== "transparent"
                ? pBoton.background
                : style.color,
              color: pBoton.color ?? "#fff",
              fontSize: pBoton.fontSize,
              fontWeight: pBoton.bold ? 700 : 600,
              borderRadius: pBoton.borderRadius,
              justifyContent: alignJustify(pBoton.align ?? style.align),
              paddingLeft: 12,
              paddingRight: 12,
            }}
          >
            {widget.text || "Botón"}
          </div>
        );

      case "rectangle":
        return <div className="h-full w-full" />;
      case "circle":
        return <div className="h-full w-full" />;
      case "line":
        return (
          <div className="flex h-full w-full items-center">
            <div
              className="w-full"
              style={{
                height: Math.max(2, style.borderWidth * 2),
                background: style.color,
                borderRadius: 9999,
              }}
            />
          </div>
        );

      case "tank":
        return (
          <div
            className="relative h-full w-full overflow-hidden"
            style={{
              background: pCaja.background !== "transparent" ? pCaja.background : "rgba(255,255,255,0.7)",
              borderRadius: pCaja.borderRadius,
              border: pCaja.borderWidth
                ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
                : undefined,
            }}
          >
            <motion.div
              className="absolute bottom-0 left-0 w-full"
              style={{
                background: pIcono.color,
              }}
              animate={{
                height: `${frac * 100}%`,
              }}
              transition={{
                type: "spring",
                stiffness: 80,
                damping: 18,
              }}
            />

            <div className="absolute inset-0 flex items-end justify-center pb-2">
              <span className="rounded bg-white/80 px-1.5 py-0.5" style={valorStyle}>
                {label}
              </span>
            </div>
          </div>
        );

      case "led":
        return (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{
              background: pCaja.background,
              borderRadius: pCaja.borderRadius,
              border: pCaja.borderWidth
                ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
                : undefined,
            }}
          >
            <motion.div
              className="h-2/3 w-2/3 rounded-full"
              animate={{
                boxShadow: on
                  ? `0 0 22px ${pIcono.color}`
                  : "0 0 0 rgba(0,0,0,0)",
              }}
              style={{
                background: on ? pIcono.color : "#94a3b8",
              }}
            />
          </div>
        );

      case "lamp":
        return (
          <div className="flex h-full w-full items-center justify-center">
            <motion.div
              className="flex items-center justify-center rounded-full"
              style={{
                width: "78%",
                height: "78%",
                background: on ? "#fde68a" : "#e2e8f0",
              }}
              animate={{
                boxShadow: on ? "0 0 28px #fbbf24" : "none",
              }}
            >
              <PowerIcon
                className="h-1/3 w-1/3"
                style={{
                  color: on ? "#b45309" : "#94a3b8",
                }}
              />
            </motion.div>
          </div>
        );

      case "gaugeCircular":
        return (
          <CircularGauge
            frac={frac}
            color={pIcono.color ?? style.color}
            label={label}
            valorStyle={valorStyle} />);
      case "gaugeLinear":
        return (
          <div className="flex h-full w-full flex-col justify-center gap-1 px-2">
            <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-200">
              <motion.div
                className="absolute left-0 top-0 h-full rounded-full"
                style={{
                  background: pIcono.color,
                }}
                animate={{
                  width: `${frac * 100}%`,
                }}
              />
            </div>
            <span className="text-center" style={valorStyle}>
              {label}
            </span>
          </div>
        );

      case "progress":
        return (
          <div className="flex h-full w-full items-center px-2">
            <div className="relative h-6 w-full overflow-hidden rounded-md bg-slate-200">
              <motion.div
                className="absolute left-0 top-0 h-full"
                style={{
                  background: style.color,
                }}
                animate={{
                  width: `${frac * 100}%`,
                }}
              />

              <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-navy">
                {label}
              </div>
            </div>
          </div>
        );

      case "switch":
        return (
          <div className="flex h-full w-full items-center justify-center">
            <div
              className="flex h-8 w-16 items-center rounded-full p-1 transition-colors"
              style={{
                background: on ? style.color : "#cbd5e1",
              }}
            >
              <motion.div
                className="h-6 w-6 rounded-full bg-white shadow"
                animate={{
                  x: on ? 30 : 0,
                }}
                transition={{
                  type: "spring",
                  stiffness: 400,
                  damping: 28,
                }}
              />
            </div>
          </div>
        );

      case "motor":
        return (
          <RotatingEquipment
            on={on}
            color={style.color}
            label={variable ? label : "Motor"}
            kind="motor"
          />
        );

      case "pump":
        return (
          <RotatingEquipment
            on={on}
            color={style.color}
            label={variable ? label : "Bomba"}
            kind="pump"
          />
        );

      case "valve":
        return (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1">
            <div className="flex items-center">
              <div className="h-2 w-6 bg-slate-400" />
              <div
                className="h-0 w-0 border-y-[18px] border-r-[22px] border-y-transparent"
                style={{
                  borderRightColor: on ? style.color : "#94a3b8",
                }}
              />

              <div
                className="h-0 w-0 border-y-[18px] border-l-[22px] border-y-transparent"
                style={{
                  borderLeftColor: on ? style.color : "#94a3b8",
                }}
              />

              <div className="h-2 w-6 bg-slate-400" />
            </div>
            <span className="text-xs font-semibold text-navy">
              {on ? "Abierta" : "Cerrada"}
            </span>
          </div>
        );

      case "sensor":
        return (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-white/80">
            <div
              className="h-3 w-3 rounded-full"
              style={{
                background: on ? "#22c55e" : "#94a3b8",
              }}
            />

            <span className="text-xs font-bold text-navy">{label}</span>
            <span className="text-[10px] uppercase tracking-wide text-slate-400">
              {widget.name}
            </span>
          </div>
        );

      // OJO: 'chart' ya NO está en el catálogo — no se puede agregar.
      // Nunca graficó nada real (MiniChart dibuja una onda seno a partir de
      // `frac`); lo reemplaza «Tendencia» (custom:trend). Este caso sigue
      // aquí solo para que un diseño guardado de antes no muestre un hueco
      // vacío donde había algo.
      case "chart":
        return <MiniChart color={style.color} frac={frac} />;
      // La imagen viaja dentro del propio diseño, como data URI en
      // `config.src` (la sube el panel del Inspector, que la reduce antes de
      // guardarla). Así se ve igual en la Vista Previa y en cualquier equipo
      // sin copiar archivos sueltos a mano.
      case "image": {
        const img = leerConfigImagen(widget.config);
        // Sin imagen todavía: el hueco de siempre, que es lo que le dice al
        // que diseña que el widget está ahí y aún le falta algo.
        if (!img.src) {
          return (
            <div className="flex h-full w-full items-center justify-center bg-slate-100 text-slate-400 dark:bg-navy-slate/40">
              <span className="text-xs">Imagen</span>
            </div>
          );
        }
        return (
          <img
            src={img.src}
            alt={img.nombre || widget.text || "Imagen"}
            draggable={false}
            // `block` quita la línea base que el navegador reserva debajo de
            // una <img> en línea: sin ella queda una franja de fondo abajo
            // que parece que la imagen está mal centrada.
            className="block h-full w-full select-none"
            style={{ objectFit: img.ajuste }}
          />
        );
      }

      default:
        return null;
    }
  };

  // The root container applies the shared appearance controls (fondo, borde,
  // radio, opacidad, rotación) to EVERY widget so each inspector property has a
  // visible effect. 'line' is purely decorative and 'button' paints its own
  // fill, so both opt out of the container fill.
  const paintsOwnFill = widget.kind === "line" || widget.kind === "button";
  const isCircle = widget.kind === "circle";
  const rootStyle: React.CSSProperties = {
    opacity: style.opacity,
    transform: `rotate(${style.rotation}deg)`,
    filter: widget.enabled ? "none" : "grayscale(0.6)",
    borderRadius: isCircle ? "50%" : style.borderRadius,
    overflow: "hidden",
  };
  if (!paintsOwnFill) {
    rootStyle.background = style.background;
    if (style.borderWidth > 0) {
      rootStyle.border = `${style.borderWidth}px solid ${style.borderColor}`;
    }
  }
  return (
    <div className="h-full w-full" style={rootStyle}>
      {content()}
    </div>
  );
}

function alignJustify(a: "left" | "center" | "right") {
  return a === "left" ? "flex-start" : a === "right" ? "flex-end" : "center";
}

function CircularGauge({
  frac,
  color,
  label,
  valorStyle,
}: {
  frac: number;
  color: string;
  label: string;
  /** Tipografía del número del centro, de la parte «Valor». */
  valorStyle?: React.CSSProperties;
}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="9"
        />

        <motion.circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={c}
          animate={{
            strokeDashoffset: c * (1 - frac * 0.75),
          }}
          transition={{
            type: "spring",
            stiffness: 60,
            damping: 16,
          }}
        />
      </svg>
      <span className="absolute" style={valorStyle}>{label}</span>
    </div>
  );
}

function RotatingEquipment({
  on,
  color,
  label,
  kind,
}: {
  on: boolean;
  color: string;
  label: string;
  kind: "motor" | "pump";
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1">
      <motion.div
        className="flex items-center justify-center rounded-full border-2"
        style={{
          width: "64%",
          height: "64%",
          borderColor: color,
          background: on ? `${color}22` : "#f1f5f9",
        }}
        animate={{
          rotate: on ? 360 : 0,
        }}
        transition={{
          repeat: on ? Infinity : 0,
          duration: 2,
          ease: "linear",
        }}
      >
        {kind === "motor" ? (
          <div className="grid h-2/3 w-2/3 place-items-center">
            <div
              className="h-full w-1 rounded"
              style={{
                background: color,
              }}
            />

            <div
              className="absolute h-1 w-2/3 rounded"
              style={{
                background: color,
              }}
            />
          </div>
        ) : (
          <div
            className="h-1/2 w-1/2 rounded-full border-2"
            style={{
              borderColor: color,
            }}
          />
        )}
      </motion.div>
      <span className="text-xs font-semibold text-navy">{label}</span>
    </div>
  );
}

function MiniChart({ color, frac }: { color: string; frac: number }) {
  const pts = Array.from(
    {
      length: 12,
    },
    (_, i) => {
      const base = 0.5 + Math.sin(i * 0.9 + frac * 6) * 0.35;
      return `${(i / 11) * 100},${100 - base * 90}`;
    },
  ).join(" ");
  return (
    <div className="h-full w-full rounded-lg border border-slate-200 bg-white p-2">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full"
      >
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
