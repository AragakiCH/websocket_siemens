// =========================================================================
// Faceplate.tsx
// Una INSTANCIA de un tipo de faceplate.
//
// QUÉ ES UN FACEPLATE AQUÍ
// El concepto es el de TIA Portal: se define un tipo una vez —un motor, una
// válvula, una cuba— y se instancia cuarenta veces; corriges el tipo y se
// corrigen las cuarenta. Lo que NO se copia de TIA es su ejecución: editor
// aparte, diálogos de interfaz y un botón de «actualizar instancias».
//
// Aquí un tipo es UNA PANTALLA MÁS, marcada como tal en el Diseñador. Con eso
// se reutiliza el editor entero: el motor se dibuja como se dibuja cualquier
// pantalla, con los mismos widgets y el mismo Inspector.
//
// CÓMO SE CONECTAN LOS TAGS
// Dentro del tipo, un widget no apunta a un tag real sino a un PARÁMETRO:
// guarda `param:marcha` en su `variableId`. Al dibujar una instancia, ese
// prefijo se cambia por el tag que esa instancia tenga asignado. No hizo
// falta ningún campo nuevo en el modelo del widget.
//
// LA PROPAGACIÓN ES AUTOMÁTICA, Y ESE ES EL PUNTO
// La instancia guarda el ID del tipo y sus parámetros, NO una copia del
// dibujo. Lee la definición al pintarse, así que cambiar el tipo cambia todas
// las instancias sin que nadie pulse nada. Si guardara una copia, esto sería
// un «duplicar» con más pasos — que es justo lo que ya se podía hacer con el
// Contenedor.
//
// LO QUE TODAVÍA NO HACE (primera entrega)
//   · No hay biblioteca separada: los tipos son pantallas del proyecto y se
//     ven en la barra de pestañas como las demás.
//   · No hay versiones ni aviso de «esta instancia se hizo con la v1».
//   · Los parámetros son tags. Todavía no se pueden pasar textos ni rangos.
// =========================================================================
import { Suspense, lazy, useEffect, useState } from 'react';
import { BoxIcon, Loader2Icon, AlertTriangleIcon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import { useAppStore } from '../../../../context/AppStore';
import {
  listarPantallas,
  type ParametroFaceplate,
  type ResumenPantalla,
} from '../../../../utils/designStorage';
import { getUltimoProyecto } from '../../../../utils/proyectoStorage';
import { estiloDeParte } from '../../partes';
import type { ModoAjuste } from '../navegacion/PantallaEmbebida';
import { usePantallaAbierta } from '../navegacion/store';

/** Ver la nota del mismo `lazy()` en PantallaScreen: rompe un ciclo de imports. */
const PantallaEmbebida = lazy(() => import('../navegacion/PantallaEmbebida'));

// ─── Config ──────────────────────────────────────────────────────

export interface ConfigFaceplate {
  /** `project_id` de la pantalla que hace de tipo. */
  tipo: string;
  /** Qué tag va en cada parámetro: `{ marcha: 'plc1|DB.run' }`. */
  params: Record<string, string>;
  ajuste: ModoAjuste;
}

export const CONFIG_FACEPLATE: ConfigFaceplate = {
  tipo: '',
  params: {},
  ajuste: 'ajustar',
};

export function leerConfigFaceplate(config: any): ConfigFaceplate {
  const c = config ?? {};
  const params: Record<string, string> = {};
  if (c.params && typeof c.params === 'object') {
    for (const [k, v] of Object.entries(c.params)) {
      if (typeof v === 'string') params[k] = v;
    }
  }
  return {
    tipo: typeof c.tipo === 'string' ? c.tipo : '',
    params,
    ajuste: ['ajustar', 'estirar', 'real'].includes(c.ajuste) ? c.ajuste : 'ajustar',
  };
}

/**
 * Los tipos de faceplate del proyecto abierto.
 *
 * Se piden a la lista de pantallas, que ya trae `es_faceplate` y los
 * parámetros de cada una: así el Inspector puede ofrecerlos y pintar sus
 * huecos sin descargarse cada pantalla entera para mirar una marca.
 */
export function useTipos(
  activo = true
): { tipos: ResumenPantalla[]; cargando: boolean } {
  const [tipos, setTipos] = useState<ResumenPantalla[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    // El panel de acciones llama a esto para CUALQUIER botón, y la lista sólo
    // le hace falta si la acción es «abrir un faceplate». Sin el interruptor,
    // seleccionar un botón cualquiera en el Diseñador pediría la lista de
    // pantallas al servidor para no usarla.
    if (!activo) return;
    let vivo = true;
    listarPantallas(getUltimoProyecto())
      .then((l) => {
        if (vivo) setTipos(l.filter((p) => p.es_faceplate));
      })
      .catch(() => {
        /* sin lista, el Inspector lo dice; no se rompe nada */
      })
      .finally(() => {
        if (vivo) setCargando(false);
      });
    return () => {
      vivo = false;
    };
  }, [activo]);

  return { tipos, cargando };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Aviso({ texto }: { texto: string }) {
  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 10,
        textAlign: 'center',
        fontSize: 11,
        lineHeight: 1.45,
        color: 'rgba(100,116,139,0.95)',
      }}
    >
      <AlertTriangleIcon style={{ width: 16, height: 16, opacity: 0.6 }} />
      {texto}
    </div>
  );
}

function Instancia({ widget, interactivo }: RenderCtx) {
  const cfg = leerConfigFaceplate(widget.config);
  const pCaja = estiloDeParte(widget, 'box');

  // ── UN FACEPLATE NO PUEDE DIBUJARSE A SÍ MISMO ───────────────────────────
  //
  // Si el tipo es la pantalla que estás mirando, dibujarlo significa: pinta
  // esta pantalla -> que contiene este faceplate -> que pinta esta pantalla…
  // sin fondo. No es que vaya lento: el navegador se queda sin memoria y la
  // pestaña muere con `Out of Memory` o `RESULT_CODE_HUNG`. Pasó de verdad.
  //
  // El corte de recursión de `PantallaEmbebida` no cubre este caso: filtra por
  // KIND (`KINDS_NAVEGACION`, el Menú y el Panel de Sección) y el faceplate no
  // está en esa lista — ni debe estarlo, porque sí es contenido de una
  // sección.
  //
  // Esta comprobación va aquí, al DIBUJAR, y no solo en el Inspector, porque
  // el Inspector no protege a un diseño que YA se guardó así: sin esto, ese
  // proyecto cuelga el navegador en cada carga y no hay forma de entrar a
  // arreglarlo.
  const pantallaAbierta = usePantallaAbierta();
  const seLlamaASiMismo = !!cfg.tipo && cfg.tipo === pantallaAbierta;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        position: 'relative',
        borderRadius: pCaja.borderRadius,
        border: pCaja.borderWidth
          ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
          : '1px dashed rgba(148,163,184,0.45)',
        background:
          pCaja.background === 'transparent' ? 'transparent' : pCaja.background,
        opacity: pCaja.opacity,
        fontFamily: 'Inter, Arial, sans-serif',
      }}
    >
      {!cfg.tipo ? (
        <Aviso texto="Elige el tipo de faceplate en las propiedades." />
      ) : seLlamaASiMismo ? (
        <Aviso texto="Este faceplate tiene asignada SU PROPIA pantalla. Se dibujaría dentro de sí mismo sin fin, así que no se dibuja. Elige otro tipo en las propiedades." />
      ) : (
        <Suspense
          fallback={
            <div
              style={{
                display: 'flex',
                height: '100%',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                fontSize: 11,
                color: 'rgba(100,116,139,0.9)',
              }}
            >
              <Loader2Icon style={{ width: 13, height: 13 }} className="animate-spin" />
              Cargando…
            </div>
          }
        >
          {/* La `key` incluye los parámetros: cambiar un tag tiene que
              repintar con el tag nuevo, no reutilizar el anterior. */}
          <PantallaEmbebida
            key={`${cfg.tipo}|${JSON.stringify(cfg.params)}`}
            projectId={cfg.tipo}
            modo={cfg.ajuste}
            interactivo={!!interactivo}
            mapaTags={cfg.params}
          />
        </Suspense>
      )}
    </div>
  );
}

// ─── Panel del Inspector ─────────────────────────────────────────

function InspectorFaceplate({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigFaceplate(config);
  const { variables } = useAppStore();
  const { tipos, cargando } = useTipos();

  // La pantalla que se está editando. Es la que NO se puede elegir como tipo:
  // un faceplate con su propia pantalla dentro se dibuja sin fin y cuelga el
  // navegador. Ver el comentario largo en `Instancia`.
  const pantallaAbierta = usePantallaAbierta();
  const yaSeLlamaASiMismo = !!cfg.tipo && cfg.tipo === pantallaAbierta;

  const tipo = tipos.find((t) => t.project_id === cfg.tipo);
  const parametros: ParametroFaceplate[] = tipo?.parametros ?? [];

  const ponerTag = (idParam: string, variableId: string) =>
    setConfig({ ...cfg, params: { ...cfg.params, [idParam]: variableId } });

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Tipo de faceplate
        </span>
        <select
          value={cfg.tipo}
          onChange={(e) =>
            // Los parámetros se vacían al cambiar de tipo: los del tipo
            // anterior no significan nada en el nuevo, y arrastrarlos dejaría
            // tags puestos en huecos que ya no existen.
            setConfig({ ...cfg, tipo: e.target.value, params: {} })
          }
          className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        >
          <option value="">— Sin tipo —</option>
          {tipos.map((t) => {
            // La pantalla actual se sigue viendo en la lista, pero apagada y
            // diciendo por qué. Esconderla sin más haría pensar que falta.
            const esEstaMisma = t.project_id === pantallaAbierta;
            return (
              <option
                key={t.project_id}
                value={t.project_id}
                disabled={esEstaMisma}
              >
                {t.nombre}
                {esEstaMisma ? ' — es esta misma pantalla' : ''}
              </option>
            );
          })}
        </select>
      </label>

      {/* Un diseño guardado ANTES de este bloqueo puede traer la
          autorreferencia puesta. Se avisa y se ofrece deshacerlo, porque el
          desplegable ya no deja seleccionar esa opción y sin esto no habría
          forma de quitarla. */}
      {yaSeLlamaASiMismo && (
        <div className="mt-2 rounded-lg border border-amber-400/40 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          Este faceplate tiene asignada <strong>su propia pantalla</strong>. No
          se dibuja, porque se contendría a sí mismo sin fin.
          <button
            type="button"
            onClick={() => setConfig({ ...cfg, tipo: '', params: {} })}
            className="mt-1.5 block rounded border border-amber-400/50 px-2 py-0.5 font-medium transition hover:bg-amber-400/20"
          >
            Quitar el tipo
          </button>
        </div>
      )}

      {cfg.tipo && parametros.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Tags de esta instancia
          </p>
          {parametros.map((p) => {
            // Solo las variables del tipo que el parámetro pide. Ofrecer una
            // booleana para una corriente es ofrecer un enlace que no va a
            // funcionar y que sólo se descubre mirando el panel en planta.
            const compatibles = variables.filter((v) => v.type === p.tipo);
            const elegida = cfg.params[p.id] ?? '';
            const huerfana = !!elegida && !variables.some((v) => v.id === elegida);
            return (
              <label key={p.id} className="block">
                <span className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    {p.nombre}
                  </span>
                  <code className="text-[10px] text-slate-400">{p.tipo}</code>
                </span>
                <select
                  value={elegida}
                  onChange={(e) => ponerTag(p.id, e.target.value)}
                  className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
                >
                  <option value="">— Sin asignar —</option>
                  {compatibles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                  {/* La que estaba puesta y ya no existe se conserva en la
                      lista: quitarla en silencio borraría el enlace sin que
                      nadie se entere de que el tag desapareció. */}
                  {huerfana && (
                    <option value={elegida}>{elegida} (ya no existe)</option>
                  )}
                </select>
              </label>
            );
          })}
        </div>
      )}

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        {cargando ? (
          'Buscando tipos de faceplate…'
        ) : tipos.length === 0 ? (
          <>
            Este proyecto no tiene ningún tipo todavía. Para crear uno: abre la
            pantalla que quieras usar de plantilla y márcala como{' '}
            <b>tipo de faceplate</b> en el menú del Diseñador, declarándole sus
            parámetros. Dentro, enlaza cada widget a un parámetro en vez de a un
            tag.
          </>
        ) : !cfg.tipo ? (
          <>
            Elige un tipo arriba. La instancia LEE la definición, así que
            corregir el tipo corrige todas las instancias sin tocarlas una a
            una.
          </>
        ) : parametros.length === 0 ? (
          <>
            «{tipo?.nombre}» no declara ningún parámetro, así que se dibuja
            igual en todas partes. Para que cada instancia lea sus propios
            tags, declárale parámetros en el menú del Diseñador de esa
            pantalla.
          </>
        ) : (
          <>
            Los huecos sin asignar se dibujan sin valor (—), no con un cero: un
            cero de mentira en un panel de planta es peor que un hueco.
          </>
        )}
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const faceplate: CustomWidgetDef = {
  kind: 'custom:faceplate',
  label: 'Faceplate',
  category: 'Básicos',
  icon: BoxIcon,
  defaultWidth: 240,
  defaultHeight: 160,
  render: (ctx) => <Instancia {...ctx} />,
  inspector: (ctx) => <InspectorFaceplate {...ctx} />,
  defaultConfig: CONFIG_FACEPLATE,
};
