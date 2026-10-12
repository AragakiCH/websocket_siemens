// =========================================================================
// CampoReceta.tsx
// Un campo de receta: un rectángulo con el valor de UN elemento.
//
// QUÉ ENSEÑA
//
//   El valor EN VIVO del tag que ese elemento tiene puesto en la vista de
//   Recetas. Se enlaza en el Inspector: «Receta» -> Habilitar receta -> y en
//   «Vínculo de datos», el elemento del grupo «Receta». Sin tag, o con el PLC
//   caído, pinta «—».
//
// DOS MODOS, Y SE DISTINGUEN DE LEJOS
//
//   * Sólo lectura: fondo negro, letra blanca.
//   * Lectura y escritura: fondo blanco, letra negra. Se pulsa y se escribe.
//
// ESCRIBIR NO ES ENVIAR
//
//   Lo que se escribe SE QUEDA en el campo aunque no se pulse Enter (la marca
//   ámbar sale desde la primera tecla distinta al PLC): es un
//   cambio pendiente, y «Guardar receta» lo lleva al data record. El campo
//   se marca con borde ámbar y una franja a la izquierda para que se vea que
//   el PLC todavía no tiene ese valor.
//
//   Enter lo envía al PLC (o «Aplicar todos», que envía todos los ámbar de
//   la receta), y al confirmarse se quita la marca. Escape
//   deshace lo tecleado en esa edición. Guardar la receta no quita la marca:
//   son dos cosas distintas, y el PLC sigue sin el valor.
//
//   Si el elemento no tiene tag, Enter no tiene a dónde enviar: avisa y la
//   marca se queda. Aun así el valor se puede guardar en la receta.
//
//   Es el mismo `config.escritura` de «Valor con Unidad» y de los ZIP, y por
//   defecto es sólo lectura: un diseño no se vuelve escribible solo.
//
// LÍMITES
//
//   Si la receta tiene marcado «Check limits», el valor se contrasta con el
//   mínimo y máximo del elemento ANTES de enviarlo. Fuera de rango: aviso y
//   no se envía. Mínimo o máximo vacío = sin límite por ese lado. Además
//   sigue mandando la lista blanca del servidor (Configuración -> Escritura),
//   como en cualquier widget que escribe.
//
// PARA «NUEVA RECETA»
//
//   Cada campo se apunta en `recetaRuntime` con su elemento, su valor y si
//   es blanco. Los botones recogen de ahí lo que hay en pantalla —solo los
//   blancos se guardan—: no hace falta decirles qué campos son los suyos.
// =========================================================================
import { useEffect, useRef, useState } from 'react';
import { TextCursorInputIcon } from 'lucide-react';
import type { CustomWidgetDef, InspectorCtx, RenderCtx } from '../types';
import { permiteEscritura } from '../../acciones';
import { escribir, partirId } from '../../../../services/escrituraApi';
import {
  esEnlaceReceta,
  fichaDeEnlace,
  partirEnlaceReceta,
} from '../../../../services/recetaEnlace';
import {
  apuntarCampo,
  borradorDe,
  enviadoAlPlc,
  fijarBorrador,
  fueraDeLimite,
  hayCambiosSinGuardar,
  llaveBorrador,
  metaDeReceta,
  quitarBorrador,
  restaurarCambios,
  useBorrador,
} from '../../../../services/recetaRuntime';
import { notificar } from './avisos';

const MONO = "Consolas, 'Courier New', monospace";
/** El color de «escrito y todavía no enviado al PLC». */
const AMBAR = '#b7791f';

/** ¿Son el mismo valor? `5`, `5.0` y `5,0` lo son. */
function mismoValor(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Number(a.replace(',', '.'));
  const y = Number(b.replace(',', '.'));
  return a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/** El valor, como se lee en un campo. */
function formatear(v: unknown, decimales: number): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (decimales > 0) return v.toFixed(decimales);
    // Sin decimales declarados no se inventan ceros, pero un Real del PLC
    // (3.1400001049) tampoco se enseña con toda su cola.
    return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
  }
  if (typeof v === 'object') return '…';
  return String(v);
}

function CampoReceta({ widget, variable, interactivo, style }: RenderCtx) {
  const escritura = permiteEscritura(widget.config);

  // ── A qué elemento de qué receta apunta ──
  const enCrudo = String(widget.variableId ?? '');
  const enlace = esEnlaceReceta(enCrudo) ? partirEnlaceReceta(enCrudo) : null;
  const ficha = enlace ? fichaDeEnlace(enCrudo) : undefined;
  const decimales = Math.max(0, Math.min(6, Math.trunc(Number(ficha?.decimales) || 0)));
  const recetaId = enlace?.recetaId ?? 0;
  const elementoId = enlace?.elementoId ?? 0;

  // Dónde se escribe: el tag de la variable YA resuelta (dentro de un
  // faceplate es el de esa instancia); si aún no hay lectura, el del elemento.
  const idTag =
    variable?.id ??
    (enlace ? ficha?.tag ?? '' : enCrudo.startsWith('param:') ? '' : enCrudo);

  // ── Lo escrito y no enviado ──
  // Por elemento, no por widget: dos campos del mismo elemento enseñan lo
  // mismo. Un campo que no es de ninguna receta lleva el suyo propio.
  const llave = enlace ? llaveBorrador(recetaId, elementoId) : `libre:${widget.id}`;
  const borradorGuardado = useBorrador(llave);
  // Solo un campo blanco puede tener algo escrito.
  const pendiente = escritura ? borradorGuardado : undefined;

  // ── Se apunta para «Nueva receta» y «Guardar receta» ──
  // El valor va por ref: cambia varias veces por segundo y volver a apuntarse
  // en cada lectura sería trabajo para nada.
  const valorRef = useRef<unknown>(null);
  valorRef.current = pendiente ?? variable?.value;
  const nombreRef = useRef('');
  const enviarRef = useRef<() => Promise<string>>(() => Promise.resolve(''));
  const cargarRef = useRef<(t: string) => void>(() => {});
  useEffect(() => {
    if (!recetaId || !elementoId) return;
    return apuntarCampo({
      recetaId,
      elementoId,
      escritura,
      leer: () => valorRef.current,
      nombre: () => nombreRef.current,
      // Directo del almacén, no del último dibujo: «Cargar» escribe el valor
      // y pide enviarlo en el mismo instante, antes de que React redibuje.
      pendiente: () => escritura && borradorDe(llave) !== undefined,
      enviar: () => enviarRef.current(),
      cargar: (t) => cargarRef.current(t),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recetaId, elementoId, escritura]);

  // ── Edición ──
  // Se puede escribir aunque el elemento no tenga tag: el valor igual sirve
  // para guardarlo en la receta. Lo que no se podrá es ENVIARLO.
  const editable = escritura && !!interactivo;
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState('');
  const [mandando, setMandando] = useState(false);
  // Lo recién enviado, mientras llega la lectura nueva del PLC: sin esto el
  // campo enseñaría un instante el valor viejo y parecería que no se envió.
  const [enviado, setEnviado] = useState<string | null>(null);
  const entrada = useRef<HTMLInputElement>(null);
  const caja = useRef<HTMLDivElement>(null);
  // El `blur` que dispara el navegador al QUITAR el input no es el operario
  // saliendo del campo: no debe asentar nada.
  const ignorarBlur = useRef(false);
  // Cómo estaba el campo al empezar a editarlo, para que Escape lo devuelva
  // tal cual: lo tecleado ya se va asentando letra a letra.
  const alAbrir = useRef<{ borrador: string | undefined; cambios: boolean }>({
    borrador: undefined,
    cambios: false,
  });

  useEffect(() => {
    if (editando) entrada.current?.select();
  }, [editando]);

  useEffect(() => {
    if (!editable && editando) setEditando(false);
  }, [editable, editando]);

  // Llegó la lectura nueva (o pasaron 3 s): ya manda lo vivo.
  useEffect(() => {
    if (enviado === null) return;
    const t = window.setTimeout(() => setEnviado(null), 3000);
    return () => window.clearTimeout(t);
  }, [enviado]);
  const valorVivo = variable?.value;
  useEffect(() => {
    setEnviado(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valorVivo]);

  // Los avisos van abajo de la pantalla, no pegados al campo: pegados
  // tapaban el campo de al lado, que es justo lo que había que mirar.
  const decir = (texto: string, tipo: 'aviso' | 'error' = 'error') => notificar(texto, tipo);

  const textoVivo =
    valorVivo === null || valorVivo === undefined ? '' : formatear(valorVivo, decimales);

  const abrir = () => {
    if (!editable || mandando || editando) return;
    ignorarBlur.current = false;
    alAbrir.current = {
      borrador: borradorDe(llave),
      cambios: recetaId ? hayCambiosSinGuardar(recetaId) : false,
    };
    setTexto(pendiente ?? textoVivo);
    setEditando(true);
  };

  const cerrar = () => {
    ignorarBlur.current = true;
    setEditando(false);
  };

  /**
   * Lo tecleado pasa a ser el valor del campo (sin enviarlo a ningún sitio).
   *
   * Vacío, o igual a lo que ya tiene el PLC, no es un cambio: se quita la
   * marca y el campo vuelve a enseñar lo vivo.
   */
  const asentar = (t: string) => {
    if (t === '' || mismoValor(t, textoVivo)) quitarBorrador(llave);
    else fijarBorrador(llave, t, recetaId);
  };

  /**
   * Manda un valor al PLC. Devuelve `''` si se envió, o el motivo si no.
   *
   * No enseña nada por su cuenta: quien llama decide cómo avisar. Lo usan
   * Enter (notificación abajo de la pantalla) y «Guardar receta» / «Cargar
   * receta» (resumen en su ventana).
   * Si no se envía, el valor se queda escrito y marcado en ámbar.
   */
  const mandarAlPlc = async (t: string): Promise<string> => {
    const retener = (motivo: string) => {
      fijarBorrador(llave, t, recetaId);
      return motivo;
    };

    const { plc_id, tag } = partirId(idTag);
    if (!idTag || !plc_id) {
      return retener(
        enlace
          ? 'no tiene TAG, así que no hay a dónde enviarlo. Asígnale uno en la vista de Recetas'
          : 'el campo no está enlazado a ningún tag del PLC'
      );
    }

    const esTexto = variable?.type === 'string';
    const num = Number(t.replace(',', '.'));
    if (!esTexto && !Number.isFinite(num)) return retener('el PLC espera un número');

    setMandando(true);
    try {
      // Límites del elemento, si la receta los comprueba. Se pregunta ahora
      // y no al dibujar: importa lo que diga la receta al enviar.
      if (enlace && !esTexto) {
        const meta = await metaDeReceta(enlace.recetaId);
        if (meta.comprobarLimites) {
          const motivo = fueraDeLimite(num, ficha?.min ?? '', ficha?.max ?? '');
          if (motivo) return retener(motivo);
        }
      }

      const valor = esTexto ? t : variable?.type === 'bool' ? num !== 0 : num;
      const r = await escribir([{ plc_id, tag, valor }]);
      // Ya está en el PLC: fuera la marca. Para la receta sigue siendo un
      // cambio sin guardar (ver `enviadoAlPlc`).
      setEnviado(t);
      enviadoAlPlc(llave, recetaId);
      // Que la escritura saliera no significa que el PLC se quedara el valor:
      // si un bloque del programa gobierna esa variable, la pisa al instante.
      const uno = r?.resultados?.[0];
      if (uno && uno.coincide === false) {
        setEnviado(null);
        return `el PLC no guardó ese valor: quedó en ${uno.confirmado}`;
      }
      return '';
    } catch (e: any) {
      return retener(e?.message ?? 'no se pudo escribir en el PLC');
    } finally {
      setMandando(false);
    }
  };

  /** Solo con Enter: asienta el valor Y lo envía al PLC. */
  const enviar = async () => {
    if (mandando) return;
    const t = texto.trim();
    if (t === '') {
      decir('Escribe un valor antes de enviarlo.', 'aviso');
      return;
    }
    asentar(t);
    cerrar();
    const motivo = await mandarAlPlc(t);
    if (!motivo) return;
    const quien = enlace ? `«${ficha?.nombre || 'Este elemento'}»` : 'Este campo';
    const sinTag = !idTag || !partirId(idTag).plc_id;
    decir(
      sinTag
        ? `${quien}: ${motivo}. El valor queda escrito y sí se puede guardar en la receta.`
        : `No se envió: ${motivo}.`,
      /no guardó|no se pudo|rechaz/i.test(motivo) ? 'error' : 'aviso'
    );
  };

  // Lo que «Guardar receta» necesita de este campo. Por ref: cambian en cada
  // dibujo, y volver a apuntarse cada vez sería trabajo para nada.
  nombreRef.current = ficha?.nombre ?? '';
  enviarRef.current = () => {
    const escrito = escritura ? borradorDe(llave) : undefined;
    return escrito === undefined ? Promise.resolve('') : mandarAlPlc(escrito);
  };
  // «Cargar receta» pone aquí el valor guardado. Si el PLC ya tiene ese
  // valor no hay nada pendiente; si no, queda escrito (ámbar) hasta enviarlo.
  // Con 0 como receta: cargar no es «un cambio sin guardar».
  cargarRef.current = (t: string) => {
    if (t === '' || mismoValor(t, textoVivo)) quitarBorrador(llave);
    else fijarBorrador(llave, t, 0);
  };

  // ── Aspecto ──
  // Negro/blanco según el modo. Si en Apariencia se le pone un fondo propio,
  // manda ese (lo pinta el contenedor) y aquí no se tapa.
  const fondoPropio = !!style.background && style.background !== 'transparent';
  const fondo = fondoPropio ? 'transparent' : escritura ? '#ffffff' : '#0b0f14';
  const tinta = escritura ? '#0b0f14' : '#ffffff';
  const letra: React.CSSProperties = {
    fontFamily: MONO,
    fontSize: style.fontSize || 14,
    fontWeight: style.bold ? 700 : 500,
    fontVariantNumeric: 'tabular-nums',
    textAlign: style.align ?? 'center',
    color: tinta,
  };
  const marcado = pendiente !== undefined;
  // La marca ámbar manda sobre el borde de Apariencia: es información de
  // operación, no decoración.
  const borde = marcado
    ? { border: `1px solid ${AMBAR}`, borderLeft: `5px solid ${AMBAR}` }
    : {
        border: style.borderWidth
          ? 'none'
          : `1px solid ${escritura ? '#9babb6' : '#3a4654'}`,
      };

  const mostrado = pendiente ?? enviado ?? formatear(valorVivo, decimales);

  return (
    <div
      ref={caja}
      onClick={abrir}
      title={
        marcado
          ? 'Valor escrito y todavía no enviado al PLC. Pulsa y confirma con Enter para enviarlo.'
          : editable
            ? 'Pulsa y escribe el valor. Enter lo envía al PLC.'
            : escritura && !interactivo
              ? 'Campo de entrada: se escribe desde la Vista Previa'
              : undefined
      }
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent:
          style.align === 'left' ? 'flex-start' : style.align === 'right' ? 'flex-end' : 'center',
        padding: '0 8px',
        background: fondo,
        ...borde,
        borderRadius: 'inherit',
        cursor: editable ? 'text' : 'default',
        overflow: 'hidden',
        opacity: mandando ? 0.6 : 1,
        ...letra,
      }}
    >
      {editando ? (
        <input
          ref={entrada}
          value={texto}
          inputMode="decimal"
          onChange={(e) => {
            // Se asienta en cada tecla: la franja ámbar sale en cuanto el
            // valor es distinto del PLC (y se va si se vuelve a dejar igual),
            // sin tener que salir del campo. «Aplicar todos» lo ve al toque.
            setTexto(e.target.value);
            asentar(e.target.value.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void enviar();
            } else if (e.key === 'Escape') {
              // Deshace lo tecleado en ESTA edición; lo que ya estaba
              // escrito de antes se queda como estaba.
              const { borrador, cambios } = alAbrir.current;
              if (borrador === undefined) quitarBorrador(llave);
              else fijarBorrador(llave, borrador);
              restaurarCambios(recetaId, cambios);
              cerrar();
            }
          }}
          // Salir del campo NO envía: lo escrito se queda como valor
          // pendiente, marcado en ámbar.
          onBlur={() => {
            if (ignorarBlur.current) return;
            asentar(texto.trim());
            cerrar();
          }}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            padding: 0,
            ...letra,
          }}
        />
      ) : (
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {mostrado}
        </span>
      )}

    </div>
  );
}

// ─── Inspector ───────────────────────────────────────────────────

function InspectorCampoReceta({ config, setConfig }: InspectorCtx) {
  const escritura = permiteEscritura(config);
  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Modo
        </span>
        <select
          value={escritura ? 'escritura' : 'lectura'}
          onChange={(e) =>
            setConfig({ ...config, escritura: e.target.value === 'escritura' })
          }
          className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        >
          <option value="lectura">Sólo lectura</option>
          <option value="escritura">Lectura y escritura</option>
        </select>
      </label>
      <p className="text-[10px] leading-relaxed text-slate-400">
        {escritura
          ? 'Fondo blanco. En la Vista Previa se escribe el valor y se queda en el campo, marcado en ámbar. «Guardar receta» lo guarda; Enter lo envía al PLC (el tag tiene que estar habilitado en Configuración → Escritura).'
          : 'Fondo negro. Solo muestra el valor en vivo del tag del elemento. No se guarda en la receta.'}
      </p>
      <p className="text-[10px] leading-relaxed text-slate-400">
        Marca «Habilitar receta» más abajo y elige el elemento en «Vínculo de
        datos», dentro del grupo «Receta».
      </p>
    </>
  );
}

export const recetaCampo: CustomWidgetDef = {
  kind: 'custom:receta-campo',
  label: 'Campo de receta',
  category: 'Recetas',
  icon: TextCursorInputIcon,
  defaultWidth: 210,
  defaultHeight: 36,
  render: (ctx) => <CampoReceta {...ctx} />,
  inspector: (ctx) => <InspectorCampoReceta {...ctx} />,
  defaultConfig: { escritura: false },
};
