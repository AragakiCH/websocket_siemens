import React, { useContext, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { PowerIcon } from "lucide-react";
import { HmiWidget } from "../../models/widget";
import { PlcVariable } from "../../models/plc";
import { formatValue, valueFraction, isTruthy } from "../../utils/format";
import { leerAccion, tieneAccion, ejecutarAccion } from "./acciones";
import { resolverEnlaces } from "../../utils/enlaces";
import { evaluarDinamicas, aplicarDinamicas } from "../../utils/dinamicas";
import { ContextoMapaTags } from "./custom/faceplate/contexto";
import { useAppStore } from "../../context/AppStore";
import { customByKind, zipByKind, zipCatalogoListo } from "./custom/registry";
import { estiloDeParte } from "./partes";
import { HtmlWidgetRenderer } from "./HtmlWidgetRenderer";
import { leerConfigImagen } from "./inspectores";

interface Props {
  widget: HmiWidget;
  variable?: PlcVariable;
  live?: boolean; // whether values animate (Designer preview always live)
  /** true en la Vista previa (se opera), false/ausente en el Diseñador. */
  interactivo?: boolean;
  /**
   * Cómo se traduce un id de variable al valor que hay ahora.
   *
   * Hace falta para las variables CON NOMBRE del widget: la principal ya
   * llega resuelta en `variable`, pero las demás las tiene que buscar alguien,
   * y quién sabe hacerlo depende de dónde se esté dibujando — en la Vista
   * Previa es buscar por id; dentro de un faceplate hay que cambiar antes
   * `param:x` por el tag de esa instancia.
   *
   * Sin él, los enlaces con nombre se quedan sin resolver. No se inventa un
   * respaldo que busque por id: en un faceplate acertaría a veces y a veces
   * leería el tag de otro equipo, que es peor que no leer nada.
   */
  resolver?: (variableId: string | null | undefined) => PlcVariable | undefined;
}

// Pure visual renderer for a single HMI widget. Reused by canvas + preview.
export function WidgetRenderer({
  widget,
  variable,
  interactivo = false,
  resolver,
}: Props) {
  // Las variables con nombre. `useMemo` porque esto corre en cada tick de

  // valores y por cada widget de la pantalla; sin él se reharía la búsqueda

  // entera aunque no hubiera cambiado ni el widget ni las lecturas.

  const enlacesResueltos = React.useMemo(

    () => (resolver ? resolverEnlaces(widget, resolver) : undefined),

    [widget, resolver]

  );

  /**
   * El aspecto que mandan las dinámicas, y el widget ya repintado con él.
   *
   * Aquí y no en cada widget: por este componente pasan los 19 de fábrica,
   * los custom en React y los importados en ZIP, así que una regla escrita
   * una vez vale para los tres y ninguno tiene que enterarse de que las
   * dinámicas existen.
   *
   * Sin reglas, `evaluarDinamicas` devuelve `null` y `aplicarDinamicas`
   * devuelve el MISMO objeto: el camino de un widget normal queda igual que
   * estaba, sin objetos nuevos ni comparaciones de estilo en cada lectura.
   */
  const efectos = React.useMemo(
    () => evaluarDinamicas(widget, variable, enlacesResueltos),
    [widget, variable, enlacesResueltos]
  );
  const pintado = React.useMemo(
    () => aplicarDinamicas(widget, efectos),
    [widget, efectos]
  );

  const { style } = pintado;

  // ── Acciones ──────────────────────────────────────────────────
  //
  // Qué manda este widget al pulsarlo. Sólo en la Vista Previa: en el
  // Diseñador el clic sirve para seleccionar y arrastrar, y escribir al PLC
  // mientras se coloca un botón sería lo contrario de lo que uno espera.
  // El modo de color vive en el contexto de la aplicación, así que no se
  // puede importar: se le pasa a la acción. Ver `EntornoAccion`.
  const { setTheme } = useAppStore();
  // Los tags de la instancia que envuelve a este widget, si esta dentro de un
  // faceplate. Sirve para que un boton de aqui dentro abra OTRO faceplate del
  // mismo equipo sin volver a elegir los tags a mano. Fuera de una instancia
  // es `undefined`, y entonces un `param:` no resuelve a nada.
  const mapaTags = useContext(ContextoMapaTags);
  const accion = leerAccion(widget.config);
  const mandaAlgo = interactivo && tieneAccion(accion);

  // El fallo tiene que VERSE. Sin esto, el operario pulsa, no pasa nada, y
  // vuelve a pulsar — que con una orden a una máquina es justo lo que no
  // debe ocurrir.
  const [avisoAccion, setAvisoAccion] = useState('');
  const relojAviso = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (relojAviso.current !== null) window.clearTimeout(relojAviso.current);
    },
    []
  );
  const [mandando, setMandando] = useState(false);

  const pulsar = async () => {
    if (!mandaAlgo || mandando) return;
    setMandando(true);
    const r = await ejecutarAccion(accion, variable, widget.text || widget.name, {
      setModoColor: setTheme,
      mapaTags,
    });
    setMandando(false);
    // Cancelar en la confirmación no es un error: no se dice nada.
    if (!r.ok && r.error) {
      setAvisoAccion(r.error);
      // El temporizador anterior se cancela antes de poner otro: si no, el
      // reloj del aviso viejo borra el nuevo al vencer, y con dos fallos
      // seguidos el segundo mensaje parpadea y desaparece sin que dé tiempo
      // a leerlo.
      if (relojAviso.current !== null) window.clearTimeout(relojAviso.current);
      relojAviso.current = window.setTimeout(() => setAvisoAccion(''), 6000);
    }
  };

  /**
   * Un widget ZIP tiene abierta una capa a pantalla completa (un modal).
   *
   * Lo dice el propio `HtmlWidgetRenderer` cuando lo detecta dentro de su
   * iframe. Aquí interesa por una razón muy concreta: `rootStyle` de abajo.
   */
  const [modalZip, setModalZip] = useState(false);
  const frac = valueFraction(variable);
  const on = isTruthy(variable);
  const label = variable ? formatValue(variable) : widget.text;
  // Estilo de cada parte: la base del `style` de siempre con lo que se haya
  // ajustado por parte encima. Un widget sin ajustes se ve exactamente igual
  // que antes, así que ningún diseño guardado cambia de aspecto.
  // Sobre el widget REPINTADO: `estiloDeParte` mira dentro del widget, así
  // que con el original las partes se quedarían con el color de diseño y una
  // dinámica de color no se vería en la mitad de los widgets.
  const pTexto = estiloDeParte(pintado, "label");
  const pCaja = estiloDeParte(pintado, "box");
  const pIcono = estiloDeParte(pintado, "icon");
  const pBoton = estiloDeParte(pintado, "boton");
  const pValor = estiloDeParte(pintado, "valor");

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
      return custom.render({
        widget: pintado, variable, style, on, frac, label, interactivo,
        enlaces: enlacesResueltos,
      });
    }

    // 👇 luego checa si es un widget HTML cargado por ZIP
    const zip = zipByKind(widget.kind);
    if (zip) {
      return (
        <HtmlWidgetRenderer
          zipWidget={zip}
          widget={pintado}
          variable={variable}
          enlaces={enlacesResueltos}
          style={style}
          interactivo={interactivo}
          onModal={setModalZip}
        />
      );
    }

    // UN `custom:` SIN DEFINICIÓN YA NO ES INVISIBLE.
    //
    // Aquí se caía al `switch` de abajo, que para un `custom:` devuelve
    // `null`: la caja se pintaba solo con su fondo, que casi siempre es
    // transparente. Eso es lo que se veía como «los widgets salen
    // transparentes» al reabrir la aplicación de escritorio, y no había
    // forma de distinguirlo de un widget bien dibujado pero vacío.
    //
    // Dos casos, y se pintan distinto a propósito:
    //   · El catálogo aún no ha llegado (los primeros milisegundos tras
    //     abrir): «cargando». Desaparece solo en cuanto llega.
    //   · El catálogo llegó y este `kind` no está: el ZIP se borró del
    //     servidor o el diseño se importó de otra instalación sin sus
    //     widgets. Se dice cuál falta, para poder volver a importarlo.
    if (widget.kind.startsWith("custom:")) {
      return (
        <WidgetSinDefinicion
          kind={widget.kind}
          cargando={!zipCatalogoListo()}
        />
      );
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
            role={mandaAlgo ? 'button' : undefined}
            tabIndex={mandaAlgo ? 0 : undefined}
            onClick={mandaAlgo ? () => void pulsar() : undefined}
            onKeyDown={
              mandaAlgo
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void pulsar();
                    }
                  }
                : undefined
            }
            className="flex h-full w-full items-center justify-center shadow-sm"
            style={{
              cursor: mandaAlgo ? (mandando ? 'progress' : 'pointer') : 'default',
              opacity: mandando ? 0.7 : undefined,
              // El fondo del botón sale de la parte «Botón». Por defecto
              // hereda `style.color`, que es lo que usaba antes.
              background: pBoton.background && pBoton.background !== "transparent"
                ? pBoton.background
                : style.color,
              // El rotulo, BLANCO salvo que se le haya puesto un color a
              // proposito. `pBoton.color` no vale aqui: hereda de
              // `style.color`, que es justo el color del FONDO del boton de
              // dos lineas mas arriba, asi que el texto salia del mismo color
              // que la caja y el boton se veia como un rectangulo liso. El
              // `?? "#fff"` de antes no llegaba a entrar nunca, porque la
              // herencia hace que ese campo nunca sea nulo.
              color: widget.partes?.boton?.color ?? "#fff",
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
          <div
            className="flex h-full w-full items-center justify-center"
            role={mandaAlgo ? 'switch' : undefined}
            aria-checked={mandaAlgo ? on : undefined}
            tabIndex={mandaAlgo ? 0 : undefined}
            onClick={mandaAlgo ? () => void pulsar() : undefined}
            onKeyDown={
              mandaAlgo
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void pulsar();
                    }
                  }
                : undefined
            }
            style={{ cursor: mandaAlgo ? 'pointer' : 'default' }}
          >
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

  // MIENTRAS UN WIDGET ZIP TENGA UN MODAL ABIERTO, ESTE DIV SE APARTA.
  //
  // `transform`, `filter` y `opacity < 1` no son solo pintura: convierten a
  // este div en el BLOQUE CONTENEDOR de cualquier `position: fixed` que haya
  // debajo. Y `rotate(0deg)` cuenta igual que `rotate(45deg)` — al navegador
  // le da lo mismo que la rotación sea nula, el bloque contenedor lo crea de
  // todos modos.
  //
  // Para un widget normal eso da igual. Para un ZIP que abre un modal es
  // fatal: el iframe se pone `fixed; inset: 0` para taparlo todo, pero el
  // "todo" pasa a ser los 140×150 del widget en vez de la ventana. El iframe
  // acaba anclado en la esquina del widget, el `overflow: hidden` de aquí y
  // el del lienzo lo recortan, y como su contenido va centrado, lo que queda
  // dentro del recorte es justo la parte vacía: modal invisible y hueco del
  // widget en blanco.
  //
  // Así que mientras dure el modal se quitan los tres. Es exactamente cuando
  // no hacen falta: el widget está tapado por el modal de todas formas.
  /**
   * Una dinámica lo ha escondido.
   *
   * Se quita de en medio SOLO donde se opera. En el Diseñador se queda a la
   * vista, atenuado: si desapareciera del lienzo no habría forma de volver a
   * seleccionarlo para cambiarle la regla que lo esconde, y la única salida
   * sería borrarlo desde otro sitio.
   */
  const oculto = !!efectos && !efectos.visible;

  const rootStyle: React.CSSProperties = {
    opacity: modalZip ? 1 : oculto ? style.opacity * 0.3 : style.opacity,
    transform: modalZip ? "none" : `rotate(${style.rotation}deg)`,
    filter: modalZip ? "none" : widget.enabled ? "none" : "grayscale(0.6)",
    borderRadius: isCircle ? "50%" : style.borderRadius,
    overflow: modalZip ? "visible" : "hidden",
  };
  if (!paintsOwnFill) {
    rootStyle.background = style.background;
    if (style.borderWidth > 0) {
      rootStyle.border = `${style.borderWidth}px solid ${style.borderColor}`;
    }
  }
  if (oculto && interactivo) return null;

  return (
    <div
      // El parpadeo, solo donde se opera: un lienzo lleno de widgets
      // parpadeando mientras se coloca el de al lado es inservible.
      className={`relative h-full w-full${
        efectos?.parpadea && interactivo ? " psi-parpadeo" : ""
      }`}
      style={rootStyle}
    >
      {content()}

      {/* El fallo de una orden tiene que VERSE, y encima del propio mando:
          si el aviso saliera en una esquina de la pantalla, en un sinóptico
          lleno nadie lo relaciona con el botón que acaba de pulsar.

          `pointer-events-none` para que no bloquee el siguiente intento. */}
      {avisoAccion && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 rounded-b bg-state-error px-1.5 py-1 text-[10px] font-semibold leading-tight text-white"
          title={avisoAccion}
        >
          {avisoAccion}
        </div>
      )}
    </div>
  );
}

/**
 * Marcador para un `custom:` que no se sabe dibujar. Ver el comentario en
 * `content()`. `pointer-events: none` para que en el Diseñador se pueda
 * seguir arrastrando y borrando como cualquier otro widget.
 */
function WidgetSinDefinicion({
  kind,
  cargando,
}: {
  kind: string;
  cargando: boolean;
}) {
  const nombre = kind.replace(/^custom:/, "");
  return (
    <div
      className={`pointer-events-none flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded border border-dashed px-1 text-center ${
        cargando
          ? "border-slate-300 bg-slate-100/60 text-slate-400 dark:border-navy-slate dark:bg-navy-slate/30"
          : "border-amber-400/70 bg-amber-50/70 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
      }`}
      title={
        cargando
          ? `Cargando el widget «${nombre}»…`
          : `El widget «${nombre}» no está en el servidor. Vuelve a importar su .zip desde el panel de widgets.`
      }
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide">
        {cargando ? "Cargando…" : "Sin widget"}
      </span>
      <span className="max-w-full truncate font-mono text-[10px]">{nombre}</span>
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
          style={{ stroke: color }}
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
          style={{ stroke: color }}
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
