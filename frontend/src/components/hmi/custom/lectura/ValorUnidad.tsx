// =========================================================================
// ValorUnidad.tsx
// Valor numérico con su unidad: «19 km/h». De lectura, o de entrada.
//
// Es el campo más común de un HMI: el número que viene del PLC y, al lado, en
// pequeño, en qué se mide. Nada más — sin escala, sin barra, sin colores por
// rango. Cuando solo hace falta leer un valor, un tanque o un medidor son
// ruido: ocupan sitio y no dicen nada que el número no diga mejor.
//
// LECTURA O ESCRITURA, COMO EL CAMPO E/A DE TIA PORTAL
// El mismo objeto sirve para enseñar una medida y para meter una consigna. En
// TIA eso es una propiedad del campo («Salida» / «Entrada/salida»), no dos
// objetos distintos, y aquí igual: un desplegable en el Inspector. Así, si una
// lectura tiene que pasar a ser ajustable, no hay que borrarla, colocar otro
// widget en su sitio y volver a enlazarlo.
//
// NACE DE LECTURA. Los diseños guardados no traen el campo `modo`, se leen
// como 'lectura' y se ven y se comportan exactamente igual que antes: nadie
// se encuentra un campo de entrada donde había un display.
//
// QUIÉN VALIDA DE VERDAD
// El servidor. `POST /escritura` comprueba lista blanca, tipo y límites ANTES
// de mandar un solo paquete al PLC, y audita quién escribió qué. Este widget
// no duplica esas reglas: pide los límites al propio servidor
// (`/escritura/permitidos`) y los usa para avisar en el momento, sin ida y
// vuelta. Si los copiara, el día que alguien cambiara un rango habría dos
// verdades y la de la pantalla sería la vieja.
//
// LA UNIDAD LA ESCRIBES TÚ
// En el Inspector, y se guarda con el diseño. No se saca del PLC a propósito:
// el OPC UA no siempre la trae, y cuando la trae suele venir como el
// programador la escribió («KMH», «Km/h», vacía). Escribiéndola tú, la
// pantalla dice lo que tiene que decir y no depende de cómo esté el servidor.
//
// POR QUÉ NO SE USA `formatValue()`
// Esa función YA le pega la unidad del PlcVariable al número. Si la usáramos,
// una variable que trae unidad saldría con las dos: «19 km/h km/h». Aquí se
// formatea solo el número y la unidad la pone este widget, una sola vez.
// =========================================================================
import { useEffect, useRef, useState } from 'react';
import { GaugeIcon, PencilIcon, Loader2Icon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import type { PlcVariable } from '../../../../models/plc';
import { useNavigate } from 'react-router-dom';
import { estiloDeParte } from '../../partes';
import { permiteEscritura } from '../../acciones';
import {
  escribir,
  permitidosCacheados,
  EVENTO_PERMITIDOS,
  partirId,
  type TagPermitido,
} from '../../../../services/escrituraApi';

// ─── Config ──────────────────────────────────────────────────────

export type ModoValor = 'lectura' | 'escritura';

export interface ConfigValorUnidad {
  unidad: string;
  /** 'lectura' = display de siempre. 'escritura' = campo E/A. */
  modo: ModoValor;
  /** Preguntar antes de mandar el valor al PLC. */
  confirmar: boolean;
}

export const CONFIG_VALOR_UNIDAD: ConfigValorUnidad = {
  unidad: '',
  modo: 'lectura',
  confirmar: false,
};

export function leerConfigValorUnidad(config: any): ConfigValorUnidad {
  const c = config ?? {};
  return {
    unidad: typeof c.unidad === 'string' ? c.unidad : '',
    // EL MODO YA NO ES DE ESTE WIDGET. Vive en `config.escritura`, compartido
    // con todos los demás, y `permiteEscritura` es quien lo resuelve — ahí
    // está también la lectura del `config.modo` de antes, para que un diseño
    // guardado con este campo en modo entrada siga siéndolo.
    //
    // Se sigue exponiendo como `modo` para no tocar las veinte lecturas de
    // este fichero: el nombre local es lo de menos, lo que importa es que hay
    // UN solo sitio donde se decide.
    modo: permiteEscritura(c) ? 'escritura' : 'lectura',
    confirmar: !!c.confirmar,
  };
}

/**
 * El número, sin unidad.
 *
 * Es `formatValue()` quitándole la última línea, la que engancha
 * `variable.unit`. Se repite aquí en vez de añadir un parámetro a la de
 * siempre porque ese `formatValue` lo usan los 18 widgets built-in y un
 * parámetro nuevo sería una bandera que hay que acertar en cada llamada.
 */
function soloValor(variable?: PlcVariable): string {
  if (!variable || variable.value === null || variable.value === undefined) return '—';
  if (variable.type === 'bool') return variable.value ? 'ON' : 'OFF';
  if (variable.type === 'string') return String(variable.value);

  const num = typeof variable.value === 'number' ? variable.value : Number(variable.value);
  if (Number.isNaN(num)) return String(variable.value);
  return variable.type === 'double' ? num.toFixed(1) : String(num);
}

// ─── La lista blanca ─────────────────────────────────────────────
//
// La caché vive en `escrituraApi`, no aquí. Aquí empezó —este fue el primer
// widget que la necesitó— y funcionaba, hasta que hubo un SEGUNDO sitio que
// leía la misma lista: la pantalla de Configuración, que además la CAMBIA.
// Con una copia por fichero, habilitar un tag dejaba a este widget diciendo
// «no admite escritura» sobre un tag recién habilitado hasta que alguien
// recargaba, y el fallo parecía del backend, que era el único que estaba bien.
//
// Ahora hay una sola copia y `olvidarPermitidos()` la tira avisando por
// `window`. Este widget escucha ese aviso y vuelve a preguntar.

/** Lo que el servidor admite para ESTE tag, o `null` si no está habilitado. */
function usePermitido(idTag: string, activo: boolean): TagPermitido | null {
  const [entrada, setEntrada] = useState<TagPermitido | null>(null);

  // Sube cada vez que un administrador toca la lista blanca. Solo sirve para
  // volver a disparar el efecto: el dato sale de `permitidosCacheados()`.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const alCambiar = () => setRevision((n) => n + 1);
    window.addEventListener(EVENTO_PERMITIDOS, alCambiar);
    return () => window.removeEventListener(EVENTO_PERMITIDOS, alCambiar);
  }, []);

  useEffect(() => {
    if (!activo || !idTag) {
      setEntrada(null);
      return;
    }
    let vivo = true;
    const { plc_id, tag } = partirId(idTag);
    permitidosCacheados()
      .then((l) => {
        if (vivo) setEntrada(l.find((x) => x.plc_id === plc_id && x.tag === tag) ?? null);
      })
      .catch(() => {
        // Sin lista no se bloquea nada: se manda y que conteste el servidor.
        // Quedarse mudo por no poder consultar un aviso previo sería peor.
        if (vivo) setEntrada(null);
      });
    return () => {
      vivo = false;
    };
  }, [idTag, activo, revision]);

  return entrada;
}

// ─── Dibujo ──────────────────────────────────────────────────────

function ValorUnidad({ widget, variable, interactivo }: RenderCtx) {
  const cfg = leerConfigValorUnidad(widget.config);
  const pValor = estiloDeParte(widget, 'valor');
  const pUnidad = estiloDeParte(widget, 'label');
  const pCaja = estiloDeParte(widget, 'box');

  /**
   * El tag donde se escribe.
   *
   * Se prefiere el de la variable YA RESUELTA: dentro de un faceplate, el
   * widget guarda `param:consigna` y quien sabe a qué tag corresponde en esta
   * instancia es `PantallaEmbebida`. Con el `variableId` en crudo, las
   * cuarenta instancias escribirían en el mismo sitio, o en ninguno.
   *
   * Si no hay lectura todavía se usa el `variableId` tal cual, siempre que no
   * sea un parámetro sin resolver: se puede escribir en un tag que aún no se
   * ha leído.
   */
  const enCrudo = String(widget.variableId ?? '');
  const idTag = variable?.id ?? (enCrudo.startsWith('param:') ? '' : enCrudo);

  const editable = cfg.modo === 'escritura' && !!interactivo && !!idTag;
  const limites = usePermitido(idTag, cfg.modo === 'escritura' && !!interactivo);

  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState('');
  const [mandando, setMandando] = useState(false);
  const [aviso, setAviso] = useState('');
  const caja = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editando) caja.current?.select();
  }, [editando]);

  // Si el widget deja de ser editable con la edición abierta —se cambia de
  // sección, se cierra el faceplate— no puede quedarse un campo a medias.
  useEffect(() => {
    if (!editable && editando) setEditando(false);
  }, [editable, editando]);

  /**
   * Enseña un aviso en el propio campo, seis segundos.
   *
   * El temporizador se guarda y se cancela antes de poner otro. Sin eso, el
   * reloj del aviso ANTERIOR sigue corriendo y borra el nuevo al vencer: dos
   * mensajes seguidos —«el máximo es 90» y, cinco segundos después, «el PLC no
   * guardó ese valor»— y el segundo se esfuma solo. Salió en las pruebas justo
   * así, y en planta es peor: el operario ve parpadear un error que no llega a
   * leer y se queda sin saber qué pasó con su orden.
   */
  const reloj = useRef<number | null>(null);
  const decir = (texto: string) => {
    setAviso(texto);
    if (reloj.current !== null) window.clearTimeout(reloj.current);
    reloj.current = window.setTimeout(() => setAviso(''), 6000);
  };

  useEffect(
    () => () => {
      if (reloj.current !== null) window.clearTimeout(reloj.current);
    },
    []
  );

  const abrir = () => {
    if (!editable || mandando) return;
    const v = variable?.value;
    setBorrador(v === null || v === undefined ? '' : String(v));
    setAviso('');
    setEditando(true);
  };

  const mandar = async () => {
    const texto = borrador.trim().replace(',', '.');
    const num = Number(texto);
    if (texto === '' || !Number.isFinite(num)) {
      decir('Escribe un número.');
      return;
    }
    // Los límites son los del SERVIDOR, y sólo se usan para avisar antes de
    // gastar una petición. El de verdad lo vuelve a comprobar él.
    if (limites?.minimo != null && num < limites.minimo) {
      decir(`El mínimo es ${limites.minimo}.`);
      return;
    }
    if (limites?.maximo != null && num > limites.maximo) {
      decir(`El máximo es ${limites.maximo}.`);
      return;
    }
    // `confirm` y no un modal propio: es una orden a una máquina, y el diálogo
    // del navegador bloquea de verdad. Mismo criterio que en `acciones.ts`.
    if (cfg.confirmar) {
      const nombre = limites?.descripcion || variable?.name || partirId(idTag).tag;
      if (!window.confirm(`¿Escribir ${num} en «${nombre}»?`)) return;
    }

    const { plc_id, tag } = partirId(idTag);
    if (!plc_id) {
      decir('Ese enlace no identifica un PLC, así que no se puede escribir.');
      return;
    }

    setMandando(true);
    try {
      const r = await escribir([{ plc_id, tag, valor: num }]);
      setEditando(false);
      // El servidor relee el tag después de escribirlo. Que la escritura
      // saliera bien no significa que el PLC se lo quedara: si un bloque del
      // programa gobierna esa variable, la pisa al instante. Callárselo dejaría
      // al operario convencido de haber cambiado algo que sigue igual.
      const uno = r?.resultados?.[0];
      if (uno && uno.coincide === false) {
        decir(`El PLC no guardó ese valor: quedó en ${uno.confirmado}.`);
      }
    } catch (e: any) {
      decir(e?.message ?? 'No se pudo escribir.');
    } finally {
      setMandando(false);
    }
  };

  /**
   * TAMAÑO DEL NÚMERO: automático hasta que lo toques.
   *
   * Se mira `widget.partes.valor.fontSize` en crudo, y no el estilo ya
   * resuelto, porque ese siempre trae un valor: el 14 que hereda del widget.
   * Con él no se puede distinguir «lo dejó como estaba» de «lo puso en 14», y
   * un readout a 14 px en una caja de 80 px de alto se ve perdido.
   *
   * Mientras no lo toques, crece con la caja: agrandas el widget y el número
   * se agranda, que es lo que esperas de un display.
   */
  const tamValor =
    widget.partes?.valor?.fontSize ??
    Math.max(14, Math.min(72, Math.round(widget.height * 0.44)));

  // Misma historia con la negrita, y por el mismo motivo: el estilo resuelto
  // hereda el `bold: false` del widget, así que preguntándole a él el número
  // saldría fino siempre. Un valor de proceso va en negrita — es lo que se
  // lee de un vistazo desde lejos —, y sigue pudiéndose quitar en Apariencia.
  const negritaValor = widget.partes?.valor?.bold ?? true;

  // Sin fondo ni borde configurados se dibuja una superficie tenue. Un campo
  // de lectura invisible no se distingue de una etiqueta suelta, y este es de
  // los widgets que se colocan en fila: sin caja no se ve dónde acaba uno y
  // empieza el siguiente. En cuanto pones fondo o borde en Apariencia → Caja,
  // manda lo tuyo (lo pinta el contenedor de WidgetRenderer) y esto se apaga.
  const sinCaja = pCaja.background === 'transparent' && !pCaja.borderWidth;

  // Un campo donde se puede escribir tiene que PARECERLO, y desde lejos. Es la
  // misma señal que da TIA enmarcando los campos E/A: sin ella, el operario no
  // tiene forma de saber cuál de los seis números de la pantalla admite que le
  // metan mano. Se marca también en el Diseñador, para que quien lo coloca vea
  // lo que verá el operador.
  const marcadoEntrada = cfg.modo === 'escritura';

  const alineacion =
    pUnidad.align === 'left' ? 'flex-start' : pUnidad.align === 'right' ? 'flex-end' : 'center';

  return (
    <div
      onDoubleClick={abrir}
      onClick={editando ? undefined : abrir}
      title={
        editable
          ? 'Pulsa para escribir un valor'
          : cfg.modo === 'escritura' && !interactivo
            ? 'Campo de entrada: se escribe desde la Vista Previa'
            : undefined
      }
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: alineacion,
        gap: Math.max(4, Math.round(tamValor * 0.16)),
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        padding: '4px 10px',
        overflow: 'hidden',
        cursor: editable && !editando ? 'text' : undefined,
        borderRadius: pCaja.borderRadius,
        background: sinCaja
          ? marcadoEntrada
            ? 'rgba(255,255,255,0.72)'
            : 'rgba(148,163,184,0.10)'
          : undefined,
        border: sinCaja
          ? marcadoEntrada
            ? '1px solid rgba(100,116,139,0.55)'
            : '1px solid rgba(148,163,184,0.32)'
          : undefined,
        // El resalte del foco va por fuera del borde, así no mueve el contenido
        // ni un píxel al empezar a editar.
        boxShadow: editando ? '0 0 0 2px rgba(0,153,153,0.45)' : undefined,
        fontFamily: 'Inter, Arial, sans-serif',
        // Las dos piezas apoyadas en la misma línea base, como se escribiría a
        // mano. Centradas por su caja, «19» y «km/h» quedan desalineadas
        // porque tienen alturas muy distintas.
        lineHeight: 1.1,
      }}
    >
      {editando ? (
        <input
          ref={caja}
          value={borrador}
          autoFocus
          disabled={mandando}
          inputMode="decimal"
          onChange={(e) => setBorrador(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void mandar();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditando(false);
            }
          }}
          // Salir del campo CANCELA, no manda. Pulsar en otro sitio de la
          // pantalla no puede acabar en una orden al autómata que nadie quiso
          // dar; para mandar hay que pulsar Enter a propósito.
          onBlur={() => !mandando && setEditando(false)}
          style={{
            width: '100%',
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            padding: 0,
            fontFamily: 'inherit',
            fontSize: tamValor,
            fontWeight: negritaValor ? 700 : 500,
            color: pValor.color,
            fontVariantNumeric: 'tabular-nums',
            textAlign:
              pUnidad.align === 'left' ? 'left' : pUnidad.align === 'right' ? 'right' : 'center',
          }}
        />
      ) : (
        <span
          style={{
            fontSize: tamValor,
            fontWeight: negritaValor ? 700 : 500,
            color: pValor.color,
            // `tabular-nums`: todas las cifras ocupan lo mismo, así el número no
            // baila de ancho al pasar de 9 a 10 con el valor actualizándose.
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            alignSelf: 'baseline',
            opacity: mandando ? 0.5 : undefined,
          }}
        >
          {soloValor(variable)}
        </span>
      )}

      {!!cfg.unidad.trim() && (
        <span
          style={{
            fontSize: pUnidad.fontSize,
            fontWeight: pUnidad.bold ? 700 : 500,
            color: pUnidad.color,
            whiteSpace: 'nowrap',
            alignSelf: 'baseline',
          }}
        >
          {cfg.unidad}
        </span>
      )}

      {/* El lápiz es la señal de «esto se puede tocar». Se quita mientras se
          edita, que entonces ya se ve el cursor. */}
      {marcadoEntrada && !editando && (
        <span
          style={{
            position: 'absolute',
            top: 3,
            right: 4,
            display: 'flex',
            color: 'rgba(100,116,139,0.75)',
            pointerEvents: 'none',
          }}
        >
          {mandando ? (
            <Loader2Icon style={{ width: 11, height: 11 }} className="animate-spin" />
          ) : (
            <PencilIcon style={{ width: 11, height: 11 }} />
          )}
        </span>
      )}

      {/* El fallo tiene que VERSE en el propio campo. Un aviso en la consola,
          en un panel de planta, no lo lee nadie. */}
      {!!aviso && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '2px 6px',
            background: 'rgba(220,38,38,0.92)',
            color: '#fff',
            fontSize: 10,
            lineHeight: 1.25,
            textAlign: 'center',
          }}
        >
          {aviso}
        </span>
      )}
    </div>
  );
}

// ─── Panel del Inspector ─────────────────────────────────────────

function InspectorValorUnidad({ widget, config, setConfig }: InspectorCtx) {
  const navigate = useNavigate();
  const cfg = leerConfigValorUnidad(config);
  const enCrudo = String(widget.variableId ?? '');
  const esParametro = enCrudo.startsWith('param:');
  const limites = usePermitido(esParametro ? '' : enCrudo, cfg.modo === 'escritura');
  const [listo, setListo] = useState(false);

  useEffect(() => {
    if (cfg.modo !== 'escritura') return;
    let vivo = true;
    permitidosCacheados().finally(() => vivo && setListo(true));
    return () => {
      vivo = false;
    };
  }, [cfg.modo]);

  const CAMPO =
    'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Modo
        </span>
        <select
          value={cfg.modo}
          onChange={(e) =>
            // Se escribe el campo COMPARTIDO, y `modo` se borra: este
            // desplegable y el del panel de Acción son dos mandos del mismo
            // interruptor, no dos interruptores.
            setConfig({
              ...config,
              escritura: e.target.value === 'escritura',
              modo: undefined,
            })
          }
          className={`${CAMPO} cursor-pointer`}
        >
          <option value="lectura">Sólo lectura</option>
          <option value="escritura">Lectura y escritura</option>
        </select>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          {cfg.modo === 'escritura'
            ? 'El operario pulsa el campo, escribe el valor y confirma con Enter. Escape cancela.'
            : 'El campo sólo muestra el valor. Es el comportamiento de siempre.'}
        </span>
      </label>

      {cfg.modo === 'escritura' && (
        <>
          <label className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Pedir confirmación
            </span>
            <input
              type="checkbox"
              checked={cfg.confirmar}
              // `...config` y NO `...cfg`: `cfg` es la config YA INTERPRETADA
              // —sólo `unidad`, `modo` y `confirmar`—, así que esparcirla
              // borraba todo lo demás que hubiera en la config, incluido el
              // `escritura` compartido. `setConfig` reemplaza, no mezcla.
              onChange={(e) => setConfig({ ...config, confirmar: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
            />
          </label>

          {/* Si el tag no está habilitado, el campo va a fallar al primer
              intento. Mejor saberlo aquí que en planta, pulsando. */}
          <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
            {esParametro ? (
              <>
                Este campo está enlazado a un <b>parámetro del faceplate</b>. Lo
                que se pueda escribir depende del tag que le ponga cada
                instancia.
              </>
            ) : !enCrudo ? (
              <>Enlaza una variable arriba para poder escribir en ella.</>
            ) : !listo ? (
              <>Comprobando si ese tag admite escritura…</>
            ) : limites ? (
              <>
                Habilitado para escritura
                {limites.minimo != null || limites.maximo != null ? (
                  <>
                    , entre <b>{limites.minimo ?? '−∞'}</b> y{' '}
                    <b>{limites.maximo ?? '∞'}</b>
                  </>
                ) : (
                  <>, sin límites definidos</>
                )}
                .
              </>
            ) : (
              <>
                <b>Ese tag no está habilitado para escritura</b>, así que el
                servidor va a rechazar el valor.
                {/* Un aviso que solo describe el problema obliga a salir,
                    acordarse del nombre exacto, entrar en Configuración y
                    buscarlo a mano. El botón hace las tres cosas.

                    Navega en la MISMA pestaña, a propósito: así sigue siendo
                    la misma aplicación cargada, y al volver el aviso ya se ha
                    enterado por `EVENTO_PERMITIDOS`. En una pestaña nueva la
                    caché de ésta se quedaría vieja igual. */}
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/config?seccion=escritura&tag=${encodeURIComponent(
                        partirId(enCrudo).tag || enCrudo
                      )}`
                    )
                  }
                  className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-siemens px-2.5 py-1.5 text-[11px] font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50"
                >
                  Habilitar «{partirId(enCrudo).tag || enCrudo}»
                </button>
              </>
            )}
          </div>
        </>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Unidad
        </span>
        <input
          value={cfg.unidad}
          // `...config`, por lo mismo que la casilla de arriba: escribir la
          // unidad no puede llevarse por delante el modo del widget.
          onChange={(e) => setConfig({ ...config, unidad: e.target.value })}
          placeholder="km/h, bar, °C, rpm…"
          className={CAMPO}
        />
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          Se escribe tal cual, sin tocar el PLC. Déjala vacía y solo se ve el
          número.
        </span>
      </label>

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        El tamaño del número se ajusta solo al alto del widget. Si quieres
        fijarlo, ponlo en <b>Apariencia → Valor</b>; la unidad se estiliza en{' '}
        <b>Apariencia → Unidad</b>.
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const valorUnidad: CustomWidgetDef = {
  kind: 'custom:valor-unidad',
  label: 'Valor con Unidad',
  category: 'Datos',
  icon: GaugeIcon,
  defaultWidth: 180,
  defaultHeight: 80,
  render: (ctx) => <ValorUnidad {...ctx} />,
  inspector: (ctx) => <InspectorValorUnidad {...ctx} />,
  defaultConfig: CONFIG_VALOR_UNIDAD,
};
