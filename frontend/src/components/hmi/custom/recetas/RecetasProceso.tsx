// =========================================================================
// custom/recetas/RecetasProceso.tsx
// El editor de recetas, dentro del lienzo.
//
// QUÉ ES Y QUÉ NO ES
// Es LA MISMA pantalla que la pestaña «Recetas» del Diseñador, con otra piel.
// No es una versión reducida ni una copia: las dos consumen el mismo
// `useRecetasEditor()`, así que un fallo del guardado se arregla una vez y se
// arregla en las dos. Y las columnas son las MISMAS, una por una — un widget
// al que le faltan campos no es la pantalla de recetas, es otra cosa.
//
// POR QUÉ EXISTE
// La pestaña del Diseñador es para quien MONTA el HMI. Esto es para quien lo
// OPERA: las recetas se eligen y se editan en la pantalla de planta, al lado
// del sinóptico, sin entrar al editor.
//
// LA DISPOSICIÓN ES LA DEL EDITOR, NO UNA NAVEGACIÓN
// Lista de recetas ARRIBA, detalle de la seleccionada ABAJO, las dos a la
// vez. Se intentó primero con navegación —lista, y al pulsar una receta se
// cambiaba al detalle— y estaba mal: al crear una receta desaparecía la
// lista, así que no se veía que se hubiera creado. Aquí la lista no se va
// nunca, igual que en la pestaña.
//
// DE DÓNDE SALE EL ASPECTO
// De la maqueta que trajo Christian: fondo claro, verde oscuro corporativo,
// botonera arriba y la banda de receta actual con su filo verde. SOLO el
// aspecto — los campos, la lógica y el modelo son los de la vista de Recetas.
//
// POR QUÉ ESTILOS EN LÍNEA Y NO TAILWIND
// Porque un widget se dibuja dentro del lienzo, que puede estar en cualquier
// tema. Las clases `bg-siemens` / `dark:bg-navy` del editor se resuelven al
// compilar y traerían los colores del Diseñador a una pantalla de planta.
// =========================================================================
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpenIcon,
  PlusIcon,
  CopyIcon,
  Trash2Icon,
  RefreshCwIcon,
  LayersIcon,
  ListIcon,
  AlertTriangleIcon,
  CheckIcon,
  Loader2Icon,
  UploadIcon,
  ChevronDownIcon,
  DatabaseIcon,
} from 'lucide-react';
import type { BaseDatos } from '../../../../services/authApi';

import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import { useRecetasEditor } from '../../../../hooks/useRecetasEditor';
import {
  COMM_TYPES,
  DATA_TYPES,
  LARGO_TIPO,
  RECIPE_TYPES,
  type CommType,
  type ElementDataType,
  type RecipeType,
} from '../../../../services/recetasApi';

// ─── La paleta de la maqueta ─────────────────────────────────────
//
// Literales y no variables del tema a propósito: lo que se pidió fue ESTE
// aspecto, el del documento que aprobó el cliente. Un widget que cambiara de
// color con la paleta del proyecto dejaría de parecerse a lo aprobado.
const C = {
  fondo: '#edf0f5',
  tinta: '#263a49',
  suave: '#586d7c',
  verde: '#01524f',
  verdeHover: '#003d3a',
  linea: '#c7d1d9',
  rojo: '#b62027',
  blanco: '#ffffff',
  chapa: '#e2e9ee',
  botonFondo: '#f9fbfd',
  botonBorde: '#b8c6ce',
  campoBorde: '#9babb6',
  /** Elemento sin tag: no tiene dónde escribir. Mismo código que TIA. */
  rosa: '#fdeaec',
  filaSel: '#dfeae8',
} as const;

const MONO = "Consolas, 'Courier New', monospace";

// ─── Las barras de desplazamiento ────────────────────────────────
//
// Van en una hoja de estilo y no en `style={}` porque `::-webkit-scrollbar`
// es un pseudo-elemento: no existe forma de escribirlo en línea. Es la única
// excepción a la regla de este archivo, y por eso la clase lleva prefijo —
// `psi-rec-` — para no pisar nada del Diseñador ni de otro widget.
//
// La nativa de Windows son 17 px de gris con dos flechas, y en una tabla de
// once columnas esa franja pesa más que una fila de datos. Aquí son 9 px,
// sin flechas, y el pulgar sólo se ve del todo cuando el ratón está encima.
const CSS_SCROLL = `
.psi-rec-scroll { scrollbar-width: thin; scrollbar-color: #b6c4cd transparent; }
.psi-rec-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
.psi-rec-scroll::-webkit-scrollbar-track { background: transparent; }
.psi-rec-scroll::-webkit-scrollbar-thumb {
  background: #c3ced6; border-radius: 999px;
  border: 2px solid transparent; background-clip: content-box;
}
.psi-rec-scroll:hover::-webkit-scrollbar-thumb { background: #9fb0ba; background-clip: content-box; }
.psi-rec-scroll::-webkit-scrollbar-thumb:hover { background: #7e929e; background-clip: content-box; }
.psi-rec-scroll::-webkit-scrollbar-corner { background: transparent; }
`;

/**
 * Alto común de TODO lo que va en la botonera: los botones y el selector de
 * base. Una constante y no un número repetido porque el defecto que se vio
 * en la captura —el desplegable más alto que los botones de al lado— nace
 * justo de eso: dos sitios con la misma medida escrita a mano, y uno se
 * queda atrás al retocar el otro.
 */
const ALTO_BOTON = 30;

export interface ConfigRecetas {
  rotulo: string;
  titulo: string;
  /** Enseñar el desplegable de base de datos en la cabecera. */
  mostrarBase: boolean;
}

export const CONFIG_RECETAS: ConfigRecetas = {
  rotulo: 'PARÁMETROS DE PROCESO',
  titulo: 'Recetas de proceso',
  mostrarBase: true,
};

export function leerConfigRecetas(config: any): ConfigRecetas {
  const c = config ?? {};
  return {
    rotulo: typeof c.rotulo === 'string' ? c.rotulo : CONFIG_RECETAS.rotulo,
    titulo: typeof c.titulo === 'string' ? c.titulo : CONFIG_RECETAS.titulo,
    mostrarBase: c.mostrarBase !== false,
  };
}

/** Fecha corta, igual que la columna Version del editor. */
function fmtVersion(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

// ─── Piezas ──────────────────────────────────────────────────────

function Boton({
  children,
  onClick,
  tipo = 'normal',
  deshabilitado,
  titulo,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tipo?: 'normal' | 'primario' | 'peligro';
  deshabilitado?: boolean;
  titulo?: string;
}) {
  const [encima, setEncima] = useState(false);
  const base =
    tipo === 'primario'
      ? { fondo: C.verde, borde: C.verde, texto: '#fff', hover: C.verdeHover }
      : tipo === 'peligro'
        ? { fondo: C.botonFondo, borde: C.botonBorde, texto: C.rojo, hover: '#f6e4e5' }
        : { fondo: C.botonFondo, borde: C.botonBorde, texto: C.tinta, hover: '#e0e8ed' };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={deshabilitado}
      title={titulo}
      onPointerEnter={() => setEncima(true)}
      onPointerLeave={() => setEncima(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: ALTO_BOTON,
        padding: '0 11px',
        border: `1px solid ${base.borde}`,
        borderRadius: 7,
        background: encima && !deshabilitado ? base.hover : base.fondo,
        color: base.texto,
        fontSize: 12,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: deshabilitado ? 'not-allowed' : 'pointer',
        opacity: deshabilitado ? 0.42 : 1,
        transition: 'background .12s',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function Campo({
  valor,
  onCambiar,
  mono,
  centrado,
  deshabilitado,
  aviso,
  marcador,
}: {
  valor: string;
  onCambiar: (v: string) => void;
  mono?: boolean;
  centrado?: boolean;
  deshabilitado?: boolean;
  /** Fondo rosa: el elemento no tiene tag y su columna no puede guardar. */
  aviso?: boolean;
  marcador?: string;
}) {
  return (
    <input
      value={valor}
      disabled={deshabilitado}
      placeholder={marcador}
      onChange={(e) => onCambiar(e.target.value)}
      style={{
        width: '100%',
        minWidth: 0,
        height: 27,
        padding: '3px 7px',
        border: `1px solid ${C.campoBorde}`,
        borderRadius: 2,
        background: deshabilitado ? '#eef2f5' : aviso ? C.rosa : C.blanco,
        color: C.tinta,
        fontFamily: mono ? MONO : 'inherit',
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
        textAlign: centrado ? 'center' : 'left',
        outline: 'none',
      }}
    />
  );
}

function Selector<T extends string>({
  valor,
  opciones,
  onCambiar,
}: {
  valor: T;
  opciones: readonly T[];
  onCambiar: (v: T) => void;
}) {
  return (
    <select
      value={valor}
      onChange={(e) => onCambiar(e.target.value as T)}
      style={{
        width: '100%',
        height: 27,
        padding: '3px 5px',
        border: `1px solid ${C.campoBorde}`,
        borderRadius: 2,
        background: C.blanco,
        color: C.tinta,
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
        outline: 'none',
      }}
    >
      {opciones.map((o) => (
        <option key={o} value={o}>
          {o || '—'}
        </option>
      ))}
    </select>
  );
}

/** Solo lectura: lo decide el sistema (p. ej. Data length). */
function Lectura({ children, centrado }: { children: React.ReactNode; centrado?: boolean }) {
  return (
    <span
      style={{
        display: 'block',
        padding: '0 6px',
        fontFamily: MONO,
        fontSize: 12,
        color: C.suave,
        fontVariantNumeric: 'tabular-nums',
        textAlign: centrado ? 'center' : 'left',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </span>
  );
}

function Th({ children, ancho }: { children?: React.ReactNode; ancho?: number }) {
  return (
    <th
      style={{
        width: ancho,
        minWidth: ancho,
        padding: '0 6px 7px',
        textAlign: 'left',
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '.05em',
        textTransform: 'uppercase',
        color: C.suave,
        borderBottom: `1px solid ${C.linea}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, ancho }: { children: React.ReactNode; ancho?: number }) {
  return (
    <td style={{ width: ancho, minWidth: ancho, padding: '3px 6px', verticalAlign: 'middle' }}>
      {children}
    </td>
  );
}

function IconoAccion({
  children,
  onClick,
  titulo,
  peligro,
  deshabilitado,
}: {
  children: React.ReactNode;
  onClick: () => void;
  titulo: string;
  peligro?: boolean;
  deshabilitado?: boolean;
}) {
  const [encima, setEncima] = useState(false);
  return (
    <button
      type="button"
      title={titulo}
      aria-label={titulo}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={deshabilitado}
      onPointerEnter={() => setEncima(true)}
      onPointerLeave={() => setEncima(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 25,
        height: 25,
        border: 'none',
        borderRadius: 5,
        background: encima ? (peligro ? '#f6e4e5' : '#dde5ea') : 'transparent',
        color: peligro ? C.rojo : C.suave,
        cursor: deshabilitado ? 'not-allowed' : 'pointer',
        opacity: deshabilitado ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Chip({ icono, children }: { icono: React.ReactNode; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 999,
        background: '#d3dfe5',
        color: '#3c5868',
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {icono}
      {children}
    </span>
  );
}

function Estado({ estado, ocupado }: { estado: string; ocupado: boolean }) {
  const [texto, fondo, tinta] = ocupado
    ? ['Trabajando…', '#d3dfe5', '#3c5868']
    : estado === 'guardando'
      ? ['Guardando…', '#fff0c7', '#755205']
      : estado === 'error'
        ? ['No se pudo guardar', '#f8e6e7', C.rojo]
        : estado === 'guardado'
          ? ['Guardado', '#cfe5df', C.verde]
          : ['Sin cambios', '#d3dfe5', '#3c5868'];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 4,
        background: fondo,
        color: tinta,
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {ocupado || estado === 'guardando' ? (
        <Loader2Icon className="animate-spin" style={{ width: 11, height: 11 }} />
      ) : estado === 'guardado' ? (
        <CheckIcon style={{ width: 11, height: 11 }} />
      ) : null}
      {texto}
    </span>
  );
}

/** Punto de estado: dice si esa conexión responde ahora mismo. */
function Punto({ vivo }: { vivo: boolean }) {
  return (
    <span
      aria-hidden="true"
      title={vivo ? 'Responde' : 'Sin conexión'}
      style={{
        width: 7,
        height: 7,
        flexShrink: 0,
        borderRadius: 999,
        background: vivo ? '#17a673' : '#d64550',
      }}
    />
  );
}

/**
 * «Guardar en»: en qué base de datos viven las cuatro tablas de recetas.
 *
 * POR QUÉ NO ES UN <select> NATIVO
 * Por lo mismo que en la vista de Recetas: la lista del `<select>` la pinta
 * el sistema operativo con SU tema, no con el de la página, y no hay CSS que
 * lo arregle. Y sobre todo, en un `<option>` no cabe más que una línea de
 * texto: ni el punto de estado, ni el motor, ni el nombre real de la base.
 * Con dos conexiones —una local y otra en el servidor— «¿cuál es cuál?» y
 * «¿cuál está caída?» son justo las dos preguntas que hay que responder
 * ANTES de elegir, no después de guardar en la equivocada.
 */
function SelectorBase({
  valor,
  bases,
  deshabilitado,
  onCambiar,
}: {
  valor: string;
  bases: BaseDatos[];
  deshabilitado: boolean;
  onCambiar: (v: string) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [resaltado, setResaltado] = useState(0);
  const [encima, setEncima] = useState(false);
  const caja = useRef<HTMLDivElement | null>(null);

  const actual = useMemo(() => bases.find((b) => b.db_id === valor), [bases, valor]);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', tecla);
    };
  }, [abierto]);

  const abrir = () => {
    if (deshabilitado) return;
    const i = bases.findIndex((b) => b.db_id === valor);
    setResaltado(i >= 0 ? i : 0);
    setAbierto(true);
  };

  const elegir = (dbId: string) => {
    setAbierto(false);
    if (dbId !== valor) onCambiar(dbId);
  };

  const teclas = (ev: React.KeyboardEvent) => {
    if (!abierto) {
      if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        abrir();
      }
      return;
    }
    if (bases.length === 0) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setResaltado((i) => (i + 1) % bases.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setResaltado((i) => (i - 1 + bases.length) % bases.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      elegir(bases[Math.min(resaltado, bases.length - 1)].db_id);
    }
  };

  // Sin catálogo —backend caído, o ninguna conexión dada de alta— se enseña
  // igualmente contra cuál se trabaja: quitar el dato sería peor que
  // enseñarlo sin poder cambiarlo.
  const soloLectura = bases.length === 0;
  const inerte = deshabilitado || soloLectura;

  return (
    <div ref={caja} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => (abierto ? setAbierto(false) : abrir())}
        onKeyDown={teclas}
        onPointerEnter={() => setEncima(true)}
        onPointerLeave={() => setEncima(false)}
        disabled={inerte}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-label="Base de datos donde viven las cuatro tablas de recetas"
        title="Base de datos donde viven las cuatro tablas de recetas"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          height: ALTO_BOTON,
          maxWidth: 270,
          padding: '0 9px',
          border: `1px solid ${abierto ? C.verde : C.botonBorde}`,
          borderRadius: 7,
          background: encima && !inerte ? '#e0e8ed' : C.botonFondo,
          color: C.tinta,
          fontFamily: 'inherit',
          fontSize: 11.5,
          cursor: inerte ? 'default' : 'pointer',
          opacity: deshabilitado ? 0.55 : 1,
          outline: 'none',
          transition: 'background .12s, border-color .12s',
        }}
      >
        <DatabaseIcon style={{ width: 13, height: 13, flexShrink: 0, color: C.suave }} />
        <span style={{ flexShrink: 0, color: C.suave }}>Guardar en</span>
        <span
          style={{
            minWidth: 0,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'left',
            fontWeight: 700,
          }}
        >
          {actual?.nombre || valor || '—'}
        </span>
        {actual && <Punto vivo={!!actual.conectado} />}
        {!soloLectura && (
          <ChevronDownIcon
            style={{
              width: 13,
              height: 13,
              flexShrink: 0,
              color: C.suave,
              transform: abierto ? 'rotate(180deg)' : 'none',
              transition: 'transform .15s',
            }}
          />
        )}
      </button>

      {abierto && !soloLectura && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 5,
            zIndex: 40,
            width: 320,
            overflow: 'hidden',
            borderRadius: 10,
            border: `1px solid ${C.linea}`,
            background: C.blanco,
            boxShadow: '0 12px 28px rgba(38,58,73,.18)',
            textAlign: 'left',
          }}
        >
          <p
            style={{
              margin: 0,
              padding: '8px 12px',
              borderBottom: `1px solid ${C.linea}`,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '.09em',
              textTransform: 'uppercase',
              color: C.suave,
            }}
          >
            Guardar las recetas en
          </p>

          <ul
            className="psi-rec-scroll"
            style={{ margin: 0, padding: 4, listStyle: 'none', maxHeight: 230, overflow: 'auto' }}
          >
            {bases.map((b, i) => {
              const puesta = b.db_id === valor;
              const activa = i === resaltado;
              return (
                <li key={b.db_id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={puesta}
                    onMouseEnter={() => setResaltado(i)}
                    onClick={() => elegir(b.db_id)}
                    style={{
                      display: 'flex',
                      width: '100%',
                      alignItems: 'center',
                      gap: 9,
                      padding: '7px 9px',
                      border: 'none',
                      borderRadius: 7,
                      background: activa ? '#e4efec' : 'transparent',
                      fontFamily: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <Punto vivo={!!b.conectado} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12,
                          fontWeight: 700,
                          color: C.tinta,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {b.nombre}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 10,
                          color: C.suave,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {[b.etiqueta_motor || b.motor, b.base_datos].filter(Boolean).join(' · ') ||
                          b.db_id}
                        {b.conectado ? '' : ' · sin conexión'}
                      </span>
                    </span>
                    {puesta && (
                      <CheckIcon style={{ width: 14, height: 14, flexShrink: 0, color: C.verde }} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <p
            style={{
              margin: 0,
              padding: '8px 12px',
              borderTop: `1px solid ${C.linea}`,
              fontSize: 10,
              lineHeight: 1.5,
              color: C.suave,
            }}
          >
            Cambia dónde se leen y se guardan recetas, elementos, registros y valores. No es la
            columna <span style={{ fontFamily: MONO }}>Path</span>, que es la carpeta del panel HMI.
          </p>
        </div>
      )}
    </div>
  );
}

function Vacio({ texto, pista }: { texto: string; pista?: string }) {
  return (
    <div
      style={{
        padding: '22px 18px',
        textAlign: 'center',
        background: '#e9eff3',
        borderRadius: 7,
        color: C.suave,
      }}
    >
      <strong style={{ fontSize: 13.5, color: C.tinta }}>{texto}</strong>
      {pista && <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.5 }}>{pista}</p>}
    </div>
  );
}

function Panel({
  titulo,
  cabecera,
  alto,
  children,
}: {
  titulo?: string;
  cabecera?: React.ReactNode;
  alto: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: alto,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: C.blanco,
        border: `1px solid ${C.linea}`,
        borderRadius: 7,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: '7px 12px',
          background: C.chapa,
          borderBottom: `1px solid ${C.linea}`,
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: C.suave,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {cabecera ?? titulo}
      </div>
      <div
        className="psi-rec-scroll"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px 12px' }}
      >
        {children}
      </div>
    </div>
  );
}

type Editor = ReturnType<typeof useRecetasEditor>;

// ─── RECIPES ─────────────────────────────────────────────────────

function TablaRecetas({ ed }: { ed: Editor }) {
  if (ed.cargando) return <Vacio texto="Cargando recetas…" />;
  if (ed.recetas.length === 0) {
    return (
      <Vacio
        texto="Todavía no hay ninguna receta."
        pista="Pulsa «Nueva receta» para crear la primera."
      />
    );
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <Th ancho={170}>Name</Th>
          <Th ancho={160}>Display name</Th>
          <Th ancho={70}>Number</Th>
          <Th ancho={135}>Version</Th>
          <Th ancho={140}>Path</Th>
          <Th ancho={110}>Type</Th>
          <Th ancho={120}>Max. data records</Th>
          <Th ancho={125}>Communication type</Th>
          <Th ancho={90}>Check limits</Th>
          <Th>Tooltip</Th>
          <Th ancho={66} />
        </tr>
      </thead>
      <tbody>
        {ed.recetas.map((r) => {
          const sel = ed.selId === r.id;
          return (
            <tr
              key={r.id}
              onClick={() => ed.setSelId(r.id)}
              style={{
                cursor: 'pointer',
                background: sel ? C.filaSel : 'transparent',
                borderBottom: `1px solid ${C.linea}`,
                // El filo verde marca la fila elegida, igual que la banda.
                boxShadow: sel ? `inset 3px 0 ${C.verde}` : 'none',
              }}
            >
              <Td>
                <Campo valor={r.name} onCambiar={(v) => ed.editarReceta(r.id, { name: v })} />
              </Td>
              <Td>
                <Campo
                  valor={r.displayName}
                  onCambiar={(v) => ed.editarReceta(r.id, { displayName: v })}
                />
              </Td>
              <Td>
                <Lectura centrado>{r.number}</Lectura>
              </Td>
              <Td>
                <Lectura>{fmtVersion(r.version)}</Lectura>
              </Td>
              <Td>
                <Campo valor={r.path} mono onCambiar={(v) => ed.editarReceta(r.id, { path: v })} />
              </Td>
              <Td>
                <Selector<RecipeType>
                  valor={r.type}
                  opciones={RECIPE_TYPES}
                  onCambiar={(v) => ed.editarReceta(r.id, { type: v })}
                />
              </Td>
              <Td>
                <Campo
                  valor={r.maxRecords}
                  mono
                  centrado
                  onCambiar={(v) => ed.editarReceta(r.id, { maxRecords: v })}
                />
              </Td>
              <Td>
                <Selector<CommType>
                  valor={r.commType}
                  opciones={COMM_TYPES}
                  onCambiar={(v) => ed.editarReceta(r.id, { commType: v })}
                />
              </Td>
              <Td>
                <div style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={r.checkLimits}
                    onChange={(e) => ed.editarReceta(r.id, { checkLimits: e.target.checked })}
                    style={{ width: 15, height: 15, accentColor: C.verde, cursor: 'pointer' }}
                  />
                </div>
              </Td>
              <Td>
                <Campo
                  valor={r.tooltip}
                  marcador="Ayuda para el operador"
                  onCambiar={(v) => ed.editarReceta(r.id, { tooltip: v })}
                />
              </Td>
              <Td>
                {/* Las acciones van EN LA FILA, no en la cabecera: así se
                    borra la receta que se señala y no «la seleccionada»,
                    que obliga a comprobar cuál estaba antes de pulsar. */}
                <div style={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                  <IconoAccion
                    titulo="Duplicar esta receta con sus elementos y registros"
                    onClick={() => ed.duplicarReceta(r.id)}
                    deshabilitado={ed.ocupado}
                  >
                    <CopyIcon style={{ width: 13, height: 13 }} />
                  </IconoAccion>
                  <IconoAccion
                    titulo="Eliminar esta receta"
                    peligro
                    onClick={() => ed.borrarReceta(r.id)}
                    deshabilitado={ed.ocupado}
                  >
                    <Trash2Icon style={{ width: 13, height: 13 }} />
                  </IconoAccion>
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── ELEMENTS ────────────────────────────────────────────────────

function TablaElementos({ ed }: { ed: Editor }) {
  const receta = ed.receta;
  if (!receta) return null;
  if (receta.elements.length === 0) {
    return (
      <Vacio
        texto="Sin elementos"
        pista="Los elementos son las columnas de la receta: un parámetro por fila, cada uno apuntando al tag del PLC donde se escribirá su valor."
      />
    );
  }

  // Los tags de los PLCs, agrupados por autómata. Elegir de una lista evita
  // la errata que luego deja la columna bloqueada sin que se sepa por qué.
  const porPlc = new Map<string, Editor['tagsPlc']>();
  for (const t of ed.tagsPlc) {
    const l = porPlc.get(t.plc);
    if (l) l.push(t);
    else porPlc.set(t.plc, [t]);
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <Th ancho={160}>Name</Th>
          <Th ancho={150}>Display name</Th>
          <Th ancho={210}>Tag</Th>
          <Th ancho={115}>Data type</Th>
          <Th ancho={85}>Data length</Th>
          <Th ancho={105}>Default value</Th>
          <Th ancho={110}>Minimum value</Th>
          <Th ancho={110}>Maximum value</Th>
          <Th ancho={105}>Decimal places</Th>
          <Th>Tooltip</Th>
          <Th ancho={40} />
        </tr>
      </thead>
      <tbody>
        {receta.elements.map((e) => {
          const sinTag = !e.tag.trim();
          return (
            <tr key={e.id} style={{ borderBottom: `1px solid ${C.linea}` }}>
              <Td>
                <Campo valor={e.name} onCambiar={(v) => ed.editarElemento(e.id, { name: v })} />
              </Td>
              <Td>
                <Campo
                  valor={e.displayName}
                  onCambiar={(v) => ed.editarElemento(e.id, { displayName: v })}
                />
              </Td>
              <Td>
                {/* Rosa cuando falta: sin tag, su columna de registros no
                    tiene dónde escribir. Mismo código visual que TIA. */}
                <select
                  value={e.tag}
                  onChange={(ev) => ed.editarElemento(e.id, { tag: ev.target.value })}
                  style={{
                    width: '100%',
                    height: 27,
                    padding: '3px 5px',
                    border: `1px solid ${C.campoBorde}`,
                    borderRadius: 2,
                    background: sinTag ? C.rosa : C.blanco,
                    color: sinTag ? C.suave : C.tinta,
                    fontFamily: MONO,
                    fontSize: 11.5,
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  <option value="">&lt;None&gt;</option>
                  {/* El tag guardado puede no estar entre los leídos: el PLC
                      quizá esté caído. No se pierde — se ofrece igual. */}
                  {e.tag && !ed.tagsPlc.some((t) => t.tag === e.tag) && (
                    <option value={e.tag}>{e.tag} (sin leer ahora)</option>
                  )}
                  {[...porPlc.entries()].map(([plc, tags]) => (
                    <optgroup key={plc} label={plc}>
                      {tags.map((t) => (
                        <option key={`${plc}|${t.tag}`} value={t.tag}>
                          {t.tag}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Td>
              <Td>
                <Selector<ElementDataType>
                  valor={e.dataType}
                  opciones={DATA_TYPES}
                  onCambiar={(v) => ed.editarElemento(e.id, { dataType: v })}
                />
              </Td>
              <Td>
                {/* Lo decide el TIPO, no se teclea: un REAL ocupa lo que
                    ocupa un REAL. */}
                <Lectura centrado>{LARGO_TIPO[e.dataType] ?? 0}</Lectura>
              </Td>
              <Td>
                <Campo
                  valor={e.defaultValue}
                  mono
                  centrado
                  onCambiar={(v) => ed.editarElemento(e.id, { defaultValue: v })}
                />
              </Td>
              <Td>
                <Campo
                  valor={e.minValue}
                  mono
                  centrado
                  marcador="—"
                  onCambiar={(v) => ed.editarElemento(e.id, { minValue: v })}
                />
              </Td>
              <Td>
                <Campo
                  valor={e.maxValue}
                  mono
                  centrado
                  marcador="—"
                  onCambiar={(v) => ed.editarElemento(e.id, { maxValue: v })}
                />
              </Td>
              <Td>
                <Campo
                  valor={e.decimals}
                  mono
                  centrado
                  onCambiar={(v) => ed.editarElemento(e.id, { decimals: v.replace(/[^0-9]/g, '') })}
                />
              </Td>
              <Td>
                <Campo
                  valor={e.tooltip}
                  marcador="Ayuda para el operador"
                  onCambiar={(v) => ed.editarElemento(e.id, { tooltip: v })}
                />
              </Td>
              <Td>
                <IconoAccion
                  titulo="Quitar este elemento"
                  peligro
                  onClick={() => ed.borrarElemento(e.id)}
                  deshabilitado={ed.ocupado}
                >
                  <Trash2Icon style={{ width: 13, height: 13 }} />
                </IconoAccion>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── DATA RECORDS ────────────────────────────────────────────────

function TablaRegistros({ ed }: { ed: Editor }) {
  const receta = ed.receta;
  if (!receta) return null;

  if (receta.elements.length === 0) {
    return (
      <Vacio
        texto="Primero hacen falta elementos"
        pista="Un registro es una fila de valores, uno por elemento. Sin columnas no hay nada que rellenar."
      />
    );
  }
  if (receta.records.length === 0) {
    return (
      <Vacio
        texto="Sin registros"
        pista="Cada registro es una fórmula concreta de esta receta: «Mezcla del lunes», «Producto B»."
      />
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <Th ancho={185}>Name</Th>
          <Th ancho={175}>Display name</Th>
          <Th ancho={70}>Number</Th>
          {receta.elements.map((e) => (
            <Th key={e.id} ancho={125}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: !e.tag.trim() ? '#8a6d1f' : undefined,
                }}
                title={
                  !e.tag.trim()
                    ? 'Este elemento no tiene tag: su columna no puede guardar valores'
                    : e.tag
                }
              >
                {!e.tag.trim() && <AlertTriangleIcon style={{ width: 10, height: 10 }} />}
                {e.displayName || e.name}
              </span>
            </Th>
          ))}
          <Th ancho={160}>Comment</Th>
          <Th ancho={66} />
        </tr>
      </thead>
      <tbody>
        {receta.records.map((r) => (
          <tr key={r.id} style={{ borderBottom: `1px solid ${C.linea}` }}>
            <Td>
              <Campo valor={r.name} onCambiar={(v) => ed.editarRegistro(r.id, { name: v })} />
            </Td>
            <Td>
              <Campo
                valor={r.displayName}
                onCambiar={(v) => ed.editarRegistro(r.id, { displayName: v })}
              />
            </Td>
            <Td>
              <Lectura centrado>{r.number}</Lectura>
            </Td>
            {receta.elements.map((e) => {
              const sinTag = !e.tag.trim();
              return (
                <Td key={e.id}>
                  <Campo
                    valor={r.values[String(e.id)] ?? ''}
                    mono
                    centrado
                    aviso={sinTag}
                    deshabilitado={sinTag}
                    // Sin valor propio se enseña el del elemento, en gris:
                    // es lo que se escribiría si este registro no lo cambia.
                    marcador={e.defaultValue || '0'}
                    onCambiar={(v) => ed.editarValor(r.id, e.id, v)}
                  />
                </Td>
              );
            })}
            <Td>
              <Campo
                valor={r.comment}
                marcador="Nota"
                onCambiar={(v) => ed.editarRegistro(r.id, { comment: v })}
              />
            </Td>
            <Td>
              <div style={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                <IconoAccion
                  titulo="Duplicar este registro con sus valores"
                  onClick={() => ed.duplicarRegistro(r.id)}
                  deshabilitado={ed.ocupado}
                >
                  <CopyIcon style={{ width: 13, height: 13 }} />
                </IconoAccion>
                <IconoAccion
                  titulo="Quitar este registro"
                  peligro
                  onClick={() => ed.borrarRegistro(r.id)}
                  deshabilitado={ed.ocupado}
                >
                  <Trash2Icon style={{ width: 13, height: 13 }} />
                </IconoAccion>
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CabeceraDetalle({ ed }: { ed: Editor }) {
  const receta = ed.receta;
  return (
    <>
      {(['elements', 'records'] as const).map((p) => {
        const activa = ed.pestana === p;
        const n = !receta ? 0 : p === 'elements' ? receta.elements.length : receta.records.length;
        return (
          <button
            key={p}
            type="button"
            onClick={() => ed.setPestana(p)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              border: 'none',
              borderRadius: 6,
              background: activa ? C.verde : 'transparent',
              color: activa ? '#fff' : C.suave,
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {p === 'elements' ? (
              <LayersIcon style={{ width: 12, height: 12 }} />
            ) : (
              <ListIcon style={{ width: 12, height: 12 }} />
            )}
            {p === 'elements' ? 'Elements' : 'Data records'}
            <span
              style={{
                padding: '0 5px',
                borderRadius: 999,
                background: activa ? 'rgba(255,255,255,.22)' : '#d3dfe5',
                color: activa ? '#fff' : '#3c5868',
                fontSize: 10,
              }}
            >
              {n}
            </span>
          </button>
        );
      })}

      {receta && (
        <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          de <b style={{ color: C.tinta }}>{receta.name}</b>
        </span>
      )}

      {receta && (
        <span style={{ marginLeft: 'auto' }}>
          <Boton
            onClick={ed.pestana === 'elements' ? ed.agregarElemento : ed.agregarRegistro}
            deshabilitado={ed.ocupado}
            tipo="primario"
          >
            <PlusIcon style={{ width: 13, height: 13 }} />
            {ed.pestana === 'elements' ? 'Agregar elemento' : 'Agregar registro'}
          </Boton>
        </span>
      )}
    </>
  );
}

// ─── El widget ───────────────────────────────────────────────────

function WidgetRecetas({ widget, interactivo = false }: RenderCtx) {
  const cfg = leerConfigRecetas(widget.config);
  const ed = useRecetasEditor();
  const receta = ed.receta;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: C.fondo,
        color: C.tinta,
        fontFamily: 'Arial, Helvetica, sans-serif',
        borderRadius: 6,
        // En el Diseñador se ve pero no se opera: ahí el puntero sirve para
        // COLOCAR el widget, y un editor que se queda los clics no se podría
        // ni mover. Mismo criterio que el resto de widgets.
        pointerEvents: interactivo ? 'auto' : 'none',
        userSelect: interactivo ? 'auto' : 'none',
      }}
    >
      <style>{CSS_SCROLL}</style>

      {/* ══ Cabecera ══════════════════════════════════════════ */}
      <div style={{ padding: '13px 16px 0', flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 14,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: '0 0 4px',
                fontSize: 11,
                letterSpacing: '.1em',
                fontWeight: 700,
                color: C.verde,
              }}
            >
              {cfg.rotulo}
            </p>
            <h1
              style={{
                margin: 0,
                fontSize: 21,
                letterSpacing: '-.025em',
                fontWeight: 650,
                lineHeight: 1.1,
              }}
            >
              {cfg.titulo}
            </h1>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
            <strong
              style={{
                fontSize: 23,
                color: C.verde,
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
              }}
            >
              {ed.recetas.length}
            </strong>
            <span style={{ fontSize: 11.5, lineHeight: 1.35, color: C.suave }}>
              receta{ed.recetas.length === 1 ? '' : 's'}
              <br />
              guardada{ed.recetas.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        {/* ── Botonera ── */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            padding: '12px 0 10px',
          }}
        >
          <Boton onClick={ed.agregarReceta} deshabilitado={ed.ocupado} tipo="primario">
            <PlusIcon style={{ width: 14, height: 14 }} />
            Nueva receta
          </Boton>
          <Boton
            onClick={() => receta && ed.duplicarReceta(receta.id)}
            deshabilitado={!receta || ed.ocupado}
            titulo={receta ? `Duplicar «${receta.name}»` : 'Elige una receta primero'}
          >
            <CopyIcon style={{ width: 14, height: 14 }} />
            Copiar receta
          </Boton>
          {/* TODAVÍA NO HACE NADA, y es el botón que más va a costar.
              «Cargar» significa escribir los valores de un registro en los
              tags de sus elementos, o sea mandar N escrituras a la máquina.
              Eso necesita lista blanca por tag, rol de escritura y auditoría.
              Se deja montado para no mover la botonera cuando llegue. */}
          <Boton
            onClick={() => {}}
            deshabilitado
            titulo="Escribir un registro en los tags del PLC. Todavía no está disponible."
          >
            <UploadIcon style={{ width: 14, height: 14 }} />
            Cargar receta
          </Boton>
          <Boton
            onClick={() => {
              void ed.recargarTodo();
              void ed.recargarTags();
            }}
            deshabilitado={ed.cargando || ed.ocupado}
            titulo="Volver a leer las recetas y los tags de los PLCs"
          >
            <RefreshCwIcon style={{ width: 14, height: 14 }} />
            Recargar
          </Boton>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* DÓNDE SE GUARDA, y se puede cambiar: el mismo control de la
                pestaña de Recetas, con el punto de estado por conexión.
                Enseñarlo como texto fijo era mentir — daba a entender que no
                se elige; y sin el punto no se sabe cuál está caída. */}
            {cfg.mostrarBase && (
              <SelectorBase
                valor={ed.dbRecetas}
                bases={ed.bases}
                deshabilitado={ed.cargando || ed.ocupado}
                onCambiar={(v) => void ed.cambiarBase(v)}
              />
            )}
            <Estado estado={ed.guardado} ocupado={ed.ocupado} />
          </div>
        </div>
      </div>

      {/* ══ Banda de la receta actual ═════════════════════════ */}
      <div
        style={{
          margin: '0 16px 10px',
          padding: '9px 14px',
          background: C.chapa,
          borderLeft: `4px solid ${C.verde}`,
          borderRadius: '0 7px 7px 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: C.suave }}>
            RECETA ACTUAL
          </span>
          <span style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>
            {ed.cargando
              ? 'Cargando…'
              : receta
                ? receta.displayName || receta.name
                : 'Sin receta seleccionada'}
          </span>
        </div>

        {receta && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <Chip icono={<LayersIcon style={{ width: 11, height: 11 }} />}>
              {receta.elements.length} elemento{receta.elements.length === 1 ? '' : 's'}
            </Chip>
            <Chip icono={<ListIcon style={{ width: 11, height: 11 }} />}>
              {receta.records.length} registro{receta.records.length === 1 ? '' : 's'}
            </Chip>
            {ed.sinTag > 0 && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px',
                  borderRadius: 999,
                  background: '#fff0c7',
                  color: '#755205',
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                <AlertTriangleIcon style={{ width: 11, height: 11 }} />
                {ed.sinTag} sin tag
              </span>
            )}
          </div>
        )}
      </div>

      {ed.error && (
        <div
          style={{
            margin: '0 16px 9px',
            padding: '8px 13px',
            border: '1px solid #d78b8b',
            background: '#fff3f3',
            color: '#8d2025',
            fontSize: 12,
            lineHeight: 1.45,
            borderRadius: 6,
            flexShrink: 0,
          }}
        >
          {ed.error}
        </div>
      )}

      {/* ══ Lista ARRIBA, detalle ABAJO — las dos a la vez ════ */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '0 16px 12px',
        }}
      >
        <Panel titulo="Recipes" alto="42%">
          <TablaRecetas ed={ed} />
        </Panel>
        <Panel cabecera={<CabeceraDetalle ed={ed} />} alto="58%">
          {!receta ? (
            <Vacio
              texto="Elige una receta de arriba"
              pista="Sus elementos y registros aparecerán aquí."
            />
          ) : ed.cargandoDetalle ? (
            <Vacio texto="Cargando el detalle…" />
          ) : ed.pestana === 'elements' ? (
            <TablaElementos ed={ed} />
          ) : (
            <TablaRegistros ed={ed} />
          )}
        </Panel>
      </div>

      <div
        style={{
          flexShrink: 0,
          borderTop: `1px solid ${C.linea}`,
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          fontSize: 11,
          color: C.suave,
        }}
      >
        <span>Se guarda solo, sin botón.</span>
        <span style={{ marginLeft: 'auto' }}>
          Lo que todavía no existe es «cargar un registro en los tags del PLC».
        </span>
      </div>
    </div>
  );
}

// ─── Inspector ───────────────────────────────────────────────────

const INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs ' +
  'text-navy outline-none transition focus:border-siemens focus:ring-2 ' +
  'focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

function InspectorRecetas({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigRecetas(config);
  const set = (parche: Partial<ConfigRecetas>) => setConfig(parche);

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Rótulo
        </span>
        <input
          value={cfg.rotulo}
          onChange={(e) => set({ rotulo: e.target.value })}
          placeholder="PARÁMETROS DE PROCESO"
          className={INPUT}
        />
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          La línea pequeña de arriba, en verde.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Título
        </span>
        <input
          value={cfg.titulo}
          onChange={(e) => set({ titulo: e.target.value })}
          placeholder="Recetas de proceso"
          className={INPUT}
        />
      </label>

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Dejar elegir la base de datos
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarBase}
          onChange={(e) => set({ mostrarBase: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>
      <span className="-mt-1 block text-[10px] leading-relaxed text-slate-400">
        El desplegable «Guardar en» de la cabecera. Apágalo en una pantalla de planta si no quieres
        que se cambie de base desde ahí.
      </span>

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        Es la MISMA pantalla que la pestaña <b>Recetas</b> del Diseñador, con los mismos campos: las
        dos comparten la lógica, así que lo que se edita aquí se ve allí y al revés. En el Diseñador
        el widget se ve pero no se opera — ahí el puntero sirve para colocarlo; pruébalo en la{' '}
        <b>Vista previa</b>.
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const recetasProceso: CustomWidgetDef = {
  kind: 'custom:recetas-proceso',
  label: 'Recetas de proceso',
  category: 'Datos',
  icon: BookOpenIcon,
  // Nace grande porque son once columnas y dos tablas a la vez: con menos, lo
  // primero que haría quien lo suelta sería agrandarlo.
  defaultWidth: 1180,
  defaultHeight: 680,
  render: (ctx) => <WidgetRecetas {...ctx} />,
  inspector: (ctx) => <InspectorRecetas {...ctx} />,
  defaultConfig: CONFIG_RECETAS,
};
