// =========================================================================
// SidebarNavegacion.tsx
// Menú lateral: declaras secciones y cada una es un botón que abre su vista.
//
// CÓMO SE USA
//   1. Arrastra este widget al lienzo
//   2. En el Inspector, arma la estructura: niveles («GENERAL», «SECADOR») y
//      dentro de cada uno sus secciones, con su icono si quieres
//   3. Arrastra un "Panel de Sección" (el otro widget) al lado
//   4. A cada widget del lienzo asígnale su "Sección" en el Inspector
//   5. Vista Previa: al pulsar un botón se muestran solo los widgets de esa
//      sección y se ocultan los de las demás
//
// NIVELES
// Un nivel es un encabezado que agrupa las secciones que van debajo. No se
// pulsa y no abre nada: está para que un menú de quince entradas se lea de un
// vistazo en vez de ser una lista plana. Las secciones que estén por encima
// del primer nivel salen sueltas, sin encabezado.
//
// A ESTE WIDGET NO LE PONGAS SECCIÓN
// Déjale la sección vacía ("En todas"). Si le asignas una, al navegar a otra
// el propio menú desaparecería y te quedarías sin forma de volver. El
// Inspector lo avisa.
// =========================================================================
import { useEffect, useMemo, useState } from 'react';
import { PanelLeftIcon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import {
  GRUPO_POR_DEFECTO,
  useVistaActiva,
  setVistaActiva,
  iniciarVista,
  publicarSecciones,
  esNivel,
  soloSecciones,
  arbolDe,
  ancestrosDe,
  type Seccion } from
'./store';
import { EditorEstructura, CampoGrupo, AvisoVistaPropia } from './inspector';
import { estiloDeParte } from '../../partes';

// ─── Config del widget ───────────────────────────────────────────

export interface ConfigSidebar {
  grupo: string;
  /**
   * Niveles y secciones en UNA lista, en el orden en que se ven.
   *
   * El nombre se queda en `secciones` aunque ahora también lleve niveles: es
   * la clave con la que se guardaron todos los menús que ya existen, y
   * renombrarla los dejaría a todos vacíos de golpe.
   */
  secciones: Seccion[];
}

export const CONFIG_SIDEBAR: ConfigSidebar = {
  grupo: GRUPO_POR_DEFECTO,
  // Algo que ver nada más soltarlo, y que además enseña la estructura: un
  // nivel con sus secciones dentro. Una caja vacía no dice qué hacer.
  secciones: [
  { id: 'general', label: 'General', tipo: 'nivel' },
  { id: 'inicio', label: 'Inicio', tipo: 'seccion' },
  { id: 'detalles', label: 'Detalles', tipo: 'seccion' },
  { id: 'graficos', label: 'Gráficos', tipo: 'seccion' }]

};

export function leerConfigSidebar(config: any): ConfigSidebar {
  const c = config ?? {};
  return {
    grupo: typeof c.grupo === 'string' && c.grupo.trim() ? c.grupo : GRUPO_POR_DEFECTO,
    secciones: Array.isArray(c.secciones) ? c.secciones : CONFIG_SIDEBAR.secciones
  };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Sidebar({ widget, style }: RenderCtx) {
  const cfg = leerConfigSidebar(widget.config);

  // Estilo por partes: la Caja, los Niveles y los botones de Sección se
  // configuran por separado en el Inspector. Antes `style.color` era a la vez
  // el fondo del botón activo y el color del encabezado, y no había forma de
  // tocar uno sin tocar el otro.
  const pCaja = estiloDeParte(widget, 'box');
  const pNivel = estiloDeParte(widget, 'label');
  const pBoton = estiloDeParte(widget, 'boton');
  const activa = useVistaActiva(cfg.grupo);

  // Al Screen y al arranque solo les interesan las entradas navegables: un
  // encabezado no es un destino, así que ni cuenta como sección ni puede ser
  // la vista inicial.
  const navegables = soloSecciones(cfg.secciones);

  useEffect(() => {
    publicarSecciones(cfg.grupo, navegables);
    if (navegables.length > 0) iniciarVista(cfg.grupo, navegables[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.grupo, cfg.secciones]);

  // ── Plegado ───────────────────────────────────────────────
  //
  // Qué ramas están CERRADAS, no cuáles abiertas: así una entrada recién
  // creada nace desplegada, que es lo que espera quien la acaba de crear.
  //
  // No se guarda con el diseño a propósito: es estado de runtime, igual que
  // la vista activa. Al abrir la Vista Previa el menú empieza limpio.
  const [cerradas, setCerradas] = useState<Set<string>>(new Set());

  const alternar = (id: string) =>
  setCerradas((prev) => {
    const s = new Set(prev);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    return s;
  });

  const filas = useMemo(() => arbolDe(cfg.secciones), [cfg.secciones]);

  /**
   * Al CAMBIAR de sección se abre la rama que lleva hasta ella.
   *
   * Sin esto puedes navegar a un subproceso con su rama plegada: la pantalla
   * cambia y el menú no enseña dónde estás, que es justo su trabajo.
   *
   * Y va al cambiar, NO permanentemente. Mantenerla abierta a la fuerza
   * mientras estuvieras dentro impedía plegar esa rama —el botón estaba y no
   * hacía nada—, y en un menú largo plegar lo que ya miraste es media razón
   * de tener el plegado. Es lo que hace cualquier explorador de archivos:
   * te revela el elemento, y después lo cierras si quieres.
   */
  useEffect(() => {
    if (!activa) return;
    const linaje = ancestrosDe(cfg.secciones, activa);
    if (linaje.length === 0) return;
    setCerradas((prev) => {
      if (!linaje.some((id) => prev.has(id))) return prev; // ya estaba abierta
      const s = new Set(prev);
      for (const id of linaje) s.delete(id);
      return s;
    });
    // Solo al cambiar de vista: con `cfg.secciones` en las dependencias, la
    // rama se volvería a abrir sola en cuanto se editara cualquier cosa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activa]);

  const estaCerrada = (id: string) => cerradas.has(id);

  /**
   * Lo que se dibuja: el árbol menos lo que cuelga de una rama plegada.
   *
   * Se recorre de arriba abajo llevando la profundidad a partir de la cual
   * todo está escondido. Basta con eso porque el árbol viene en orden de
   * padres antes que hijos: cuando se cierra una rama, todo lo que sigue con
   * más profundidad es suyo.
   */
  const visibles = useMemo(() => {
    const salida: typeof filas = [];
    let ocultarDesde = Infinity;
    for (const fila of filas) {
      if (fila.profundidad > ocultarDesde) continue;
      ocultarDesde = Infinity;
      salida.push(fila);
      if (fila.tieneHijos && estaCerrada(fila.seccion.id)) {
        ocultarDesde = fila.profundidad;
      }
    }
    return salida;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filas, cerradas]);

  const tamBoton = pBoton.fontSize ?? 13;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        borderRadius: pCaja.borderRadius,
        border: pCaja.borderWidth ?
        `${pCaja.borderWidth}px solid ${pCaja.borderColor}` :
        '1px solid rgba(148,163,184,0.35)',
        background:
        pCaja.background === 'transparent' ? 'rgba(15,23,42,0.04)' : pCaja.background,
        opacity: pCaja.opacity,
        fontFamily: 'Inter, Arial, sans-serif'
      }}>

      {/* SIN TÍTULO. Lo tuvo y se quitó: ocupaba una franja fija arriba para
          repetir algo que ya se sabe — en qué pantalla estás lo dice la
          cabecera del Panel de Sección, y cuál es el menú lo dice el propio
          menú. En un panel de planta ese espacio vale más para una sección
          más visible. */}

      <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
        {cfg.secciones.length === 0 ?
        <p
          style={{
            padding: '10px 8px',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'rgba(100,116,139,0.9)'
          }}>

            Sin secciones. Agrégalas en el Inspector, a la derecha.
          </p> :

        visibles.map(({ seccion: s, profundidad, tieneHijos }, i) => {
          // Sangría por profundidad, IGUAL para encabezados y secciones.
          //
          // Antes las secciones llevaban 16 px extra —herencia de cuando una
          // sección siempre iba dentro de un encabezado— y eso hacía que una
          // sección de la raíz se viera metida dentro del encabezado que
          // tuviera encima, aunque no colgara de él. La sangría mentía sobre
          // la jerarquía, que es lo único que la sangría tiene que decir.
          //
          // 8 px de base y 13 por nivel: se lee la jerarquía sin comerse el
          // ancho útil en un menú de tres niveles dentro de un panel
          // estrecho.
          const sangria = 8 + profundidad * 13;
          const cerrada = tieneHijos && estaCerrada(s.id);

          // ── Encabezado de nivel ─────────────────────────────
          if (esNivel(s)) {
            return (
              <div
                key={s.id}
                onClick={(e) => {
                  // Un encabezado no navega, pero con hijos SÍ pliega. Es la
                  // única forma de que un menú de once entradas se lea de un
                  // vistazo sin desplazarse.
                  if (!tieneHijos) return;
                  e.stopPropagation();
                  alternar(s.id);
                }}
                style={{
                  // Aire ARRIBA y no abajo, y ninguno en el primero: es lo
                  // que separa un grupo del anterior. Repartido a los dos
                  // lados, el encabezado quedaría flotando entre los dos
                  // grupos sin pertenecer a ninguno.
                  //
                  // SANGRÍA: el encabezado pegado a la izquierda y las
                  // secciones metidas hacia dentro. Es lo único que dice qué
                  // cuelga de qué; sin ello el menú se lee como una lista
                  // plana con mayúsculas sueltas por medio.
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  paddingLeft: sangria,
                  cursor: tieneHijos ? 'pointer' : 'default',
                  marginTop: i === 0 ? 0 : 10,
                  fontSize: Math.max(9, tamBoton - 4),
                  fontWeight: pNivel.bold === false ? 600 : 700,
                  letterSpacing: 0.8,
                  textTransform: 'uppercase',
                  // A LA IZQUIERDA SIEMPRE, y no `pNivel.align`.
                  //
                  // Aquí estaba el fallo: `align` sale del estilo del widget y
                  // vale 'center' de fábrica, así que el encabezado se pintaba
                  // centrado. Y un texto centrado se come el padding izquierdo
                  // — la sangría estaba puesta y no se veía ninguna.
                  //
                  // Un encabezado centrado sobre una lista alineada a la
                  // izquierda no funciona en ningún menú: la columna por la
                  // que se lee es el borde izquierdo, y el rótulo del grupo
                  // tiene que empezar en ella. Por eso va fijo y se le quitó
                  // el control de alineación del Inspector, en vez de dejar un
                  // ajuste que solo sirve para estropearlo.
                  textAlign: 'left',
                  color: pNivel.color,
                  opacity: 0.7,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}>

                  {/* El hueco de la flecha se reserva SIEMPRE, tenga hijos o
                    no. Si apareciera y desapareciera, el rótulo bailaría de
                    sitio entre una fila y la de al lado y la columna por la
                    que se lee el menú dejaría de ser recta. */}
                  <span
                  style={{
                    width: 10,
                    flexShrink: 0,
                    display: 'inline-flex',
                    justifyContent: 'center',
                    visibility: tieneHijos ? 'visible' : 'hidden',
                    transition: 'transform 0.15s',
                    transform: cerrada ? 'rotate(-90deg)' : 'none',
                    fontSize: '0.8em',
                    lineHeight: 1
                  }}>
                    ▾
                  </span>
                  <span
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}>
                    {s.label || s.id}
                  </span>
                </div>);

          }

          // ── Sección ─────────────────────────────────────────
          const esActiva = s.id === activa;

          // Fondo del botón activo: el que se haya puesto en la parte
          // «Secciones», y si no, el color del widget.
          const fondoActivo =
          pBoton.background && pBoton.background !== 'transparent' ?
          pBoton.background :
          style.color;

          // EL TEXTO ACTIVO NO PUEDE SER DEL COLOR DE SU PROPIO FONDO.
          //
          // `pBoton.color` hereda `style.color` cuando nadie tocó la parte, y
          // ese es EXACTAMENTE el color que acaba de usarse como fondo: la
          // sección abierta salía con el rótulo invisible, teal sobre teal.
          // Un menú recién soltado se veía roto sin que nada estuviera mal
          // configurado.
          //
          // Solo se descarta si coinciden; un color elegido a mano se
          // respeta siempre.
          const mismoColor =
          (pBoton.color ?? '').toLowerCase() === String(fondoActivo).toLowerCase();

          const colorTexto = esActiva ?
          !pBoton.color || mismoColor ? '#fff' : pBoton.color :
          'rgba(100,116,139,1)';

          return (
            <button
              key={s.id}
              type="button"
              // En el lienzo del Diseñador los clics los captura CanvasWidget
              // para seleccionar y arrastrar; aquí solo llega en Vista Previa.
              onClick={(e) => {
                e.stopPropagation();
                setVistaActiva(cfg.grupo, s.id);
              }}
              title={s.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                width: '100%',
                // Sangrada respecto al encabezado (8 px → 24 px), pero el
                // botón sigue ocupando TODO el ancho: lo que se mete hacia
                // dentro es el contenido, no la caja. Así el fondo de la
                // sección activa cruza el menú de lado a lado, que es lo que
                // la hace visible de un vistazo desde lejos.
                // La sangría va en el CONTENIDO, no en la caja: el botón
                // sigue ocupando todo el ancho, así el fondo de la sección
                // activa cruza el menú de lado a lado y se ve desde lejos.
                padding: '8px 10px',
                paddingLeft: sangria,
                marginBottom: 2,
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
                fontSize: tamBoton,
                fontWeight: esActiva ? 700 : pBoton.bold ? 700 : 500,
                // El color de la parte «Secciones» es el del botón activo;
                // los inactivos van en gris para que se distingan solos.
                color: colorTexto,
                background: esActiva ? fondoActivo : 'transparent',
                borderRadius: pBoton.borderRadius ?? 8,
                transition: 'background 0.15s, color 0.15s',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}>

              {/* Desplegar/plegar. Es un <span> con su propio onClick y no
                  un <button>: dentro de otro botón, un botón anidado no es
                  HTML válido y el navegador rompe el árbol.

                  Se para la propagación para que abrir la rama NO navegue:
                  son dos intenciones distintas y toca poder hacer una sin la
                  otra. Pulsar el rótulo sí navega. */}
              <span
                role={tieneHijos ? 'button' : undefined}
                tabIndex={-1}
                onClick={(e) => {
                  if (!tieneHijos) return;
                  e.stopPropagation();
                  alternar(s.id);
                }}
                title={tieneHijos ? (cerrada ? 'Desplegar' : 'Plegar') : undefined}
                style={{
                  width: 10,
                  flexShrink: 0,
                  display: 'inline-flex',
                  justifyContent: 'center',
                  // Reservado siempre: ver el comentario del encabezado.
                  visibility: tieneHijos ? 'visible' : 'hidden',
                  cursor: 'pointer',
                  transition: 'transform 0.15s',
                  transform: cerrada ? 'rotate(-90deg)' : 'none',
                  fontSize: '0.75em',
                  lineHeight: 1,
                  opacity: 0.75
                }}>
                ▾
              </span>

              {/* Icono, si la sección tiene uno.
                  ANTES AQUÍ HABÍA UNA BARRITA de 3 px que se pintaba siempre.
                  No significaba nada: ni decía qué era la sección ni marcaba
                  la activa mejor que el propio fondo del botón. Era ruido en
                  cada fila. Ahora, o hay icono o no hay nada, y sin icono el
                  rótulo empieza donde empieza el botón.

                  El `color` heredado es la razón de meter el SVG en línea y
                  no una <img>: un icono hecho con `currentColor` se tiñe solo
                  del color del texto y cambia al activarse la sección. */}
              {!!s.icono &&
              <span
                className="icono-svg"
                style={{
                  width: Math.round(tamBoton * 1.15),
                  height: Math.round(tamBoton * 1.15),
                  flexShrink: 0,
                  display: 'inline-flex',
                  color: colorTexto
                }}
                // Saneado al guardarse, en limpiarSvg().
                dangerouslySetInnerHTML={{ __html: s.icono }} />
              }
              {s.label || s.id}
            </button>);

        })
        }
      </div>
    </div>);

}

// ─── Panel del Inspector ─────────────────────────────────────────

function InspectorSidebar({ widget, config, setConfig }: InspectorCtx) {
  const cfg = leerConfigSidebar(config);
  return (
    <>
      <AvisoVistaPropia vista={widget.vista} />

      <CampoGrupo
        valor={cfg.grupo}
        onChange={(grupo) => setConfig({ ...cfg, grupo })} />

      <EditorEstructura
        secciones={cfg.secciones}
        onChange={(secciones) => setConfig({ ...cfg, secciones })} />
    </>);

}

// ─── Definición ──────────────────────────────────────────────────

export const sidebarNavegacion: CustomWidgetDef = {
  kind: 'custom:sidebar-navegacion',
  label: 'Menú Lateral',
  category: 'Básicos',
  icon: PanelLeftIcon,
  defaultWidth: 180,
  defaultHeight: 320,
  render: (ctx) => <Sidebar {...ctx} />,
  inspector: (ctx) => <InspectorSidebar {...ctx} />,
  defaultConfig: CONFIG_SIDEBAR
};
