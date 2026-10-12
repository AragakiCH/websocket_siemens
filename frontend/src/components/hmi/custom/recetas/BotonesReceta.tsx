// =========================================================================
// BotonesReceta.tsx
// Los botones de receta como widgets sueltos: Nueva, Guardar y Cargar.
//
// Son los mismos de la botonera del widget «Recetas de proceso», pero cada
// uno por separado, para colocarlos donde haga falta en una pantalla propia.
// A cada uno se le elige la receta en el Inspector (sección «Receta»).
//
// «RECETA» AQUÍ ES UN DATA RECORD
//
//   Para quien opera, una «receta» es un juego de valores con nombre. En la
//   base eso es un data record de la receta elegida en el Inspector
//   (PLANTILLA 1). Los valores salen de los «Campo de receta» BLANCOS que
//   hay en pantalla.
//
// «NUEVA RECETA»
//
//   Pide un nombre y crea el data record con lo que hay en los campos. El
//   nombre no puede repetirse. Si hay cambios sin guardar en la receta
//   actual, avisa de que primero se guarden y no abre la ventana: crear otra
//   encima de cambios sin guardar es la forma fácil de perderlos.
//
// «GUARDAR RECETA»
//
//   Dos opciones: «Modificar receta actual» (escribe encima de la que está
//   cargada, y enseña su nombre) o «Guardar como nueva» (otro nombre, sin
//   tocar la original).
//
//   Además de guardar, ENVÍA AL PLC los valores escritos y sin enviar (los
//   campos de borde ámbar), uno por uno: es lo que evita ir dando Enter
//   campo por campo. La receta se guarda siempre; si alguno no se puede
//   enviar (sin tag, sin permiso de escritura, PLC caído), la ventana se
//   queda abierta diciendo cuál y por qué, y ese campo sigue en ámbar.
//   «Nueva receta» NO envía nada: solo crea.
//
//
// «CARGAR RECETA»
//
//   Lista los data records de la receta (solo los nombres). Al elegir uno y
//   confirmar, pone cada valor en el campo blanco de su elemento y lo ENVÍA
//   AL PLC, uno por uno — así el campo negro del mismo elemento enseña ya el
//   valor nuevo. La cargada pasa a ser la receta actual. Lo que no se pudo
//   enviar se queda en su campo, en ámbar, y la ventana dice cuál y por qué.
//   Con cambios sin guardar no deja cargar: primero se guardan.
//
//   A SU DERECHA se pinta solo el bloque «RECETA ACTUAL»: el nombre de la
//   que está cargada y su estado («Guardada» / «Sin guardar»). Va pegado a
//   este botón y lo sigue allá donde se coloque; no es un widget aparte.
//
// «ELIMINAR RECETA» Y EL CONTADOR
//
//   «Eliminar receta» lista las guardadas con su fecha; se elige una, se
//   pulsa Continuar y pide confirmación antes de borrar: no se deshace.
//   No toca el PLC ni los campos. El contador enseña cuántas hay guardadas.
//
// LOS AVISOS de los tres salen abajo de la pantalla (ver `avisos.ts`), no
// pegados al botón: ahí tapaban los campos.
// =========================================================================
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PlusIcon,
  CheckIcon,
  UploadIcon,
  XIcon,
  ListOrderedIcon,
  SendIcon,
  type LucideIcon,
} from 'lucide-react';
import type { CustomWidgetDef, RenderCtx } from '../types';
import { leerCfgReceta } from '../../../../services/recetaEnlace';
import {
  cargarDataRecord,
  enviarPendientes,
  eliminarDataRecord,
  guardarDataRecord,
  hayCambiosSinGuardar,
  listarRegistros,
  pendientesDeEnviar,
  recetaActual,
  useConteoRecetas,
  useEstadoReceta,
  usePendientesDeEnviar,
  valoresEnPantalla,
  type RegistroExistente,
  type ResultadoCargar,
  type ResultadoEnvio,
} from '../../../../services/recetaRuntime';
import { BajoWidget } from './BajoWidget';
import { notificar } from './avisos';

// Los mismos colores que la botonera de RecetasProceso, a propósito: puestos
// al lado tienen que leerse como la misma familia.
const C = {
  tinta: '#263a49',
  suave: '#586d7c',
  verde: '#01524f',
  verdeHover: '#003d3a',
  fondo: '#f9fbfd',
  fondoHover: '#e0e8ed',
  borde: '#b8c6ce',
  rojo: '#b62027',
  ambar: '#b7791f',
  seleccion: '#e8f3f0',
  campoApagado: '#e6eaee',
  franja: '#e2e9ee',
} as const;

const FUENTE = 'Inter, Arial, sans-serif';

function BotonReceta({
  ctx,
  texto,
  Icono,
  primario,
  peligro,
  onPulsar,
  refBoton,
  apagado,
  extra,
}: {
  ctx: RenderCtx;
  texto: string;
  Icono: LucideIcon;
  primario?: boolean;
  /** Texto e icono en rojo: es una acción que destruye algo. */
  peligro?: boolean;
  /** Sin él, el botón todavía no tiene función. */
  onPulsar?: () => void;
  refBoton?: React.RefObject<HTMLButtonElement>;
  /** Se ve, pero no hay nada que hacer ahora (gris y sin clic). */
  apagado?: boolean;
  /** Algo más tras el texto (p. ej. la cuenta de «Aplicar todos»). */
  extra?: React.ReactNode;
}) {
  const [encima, setEncima] = useState(false);
  const activo = !!ctx.interactivo && !apagado;
  const fondo = apagado
    ? C.fondo
    : primario
    ? encima ? C.verdeHover : C.verde
    : encima ? (peligro ? '#f6e4e5' : C.fondoHover) : C.fondo;
  return (
    <button
      ref={refBoton}
      type="button"
      title={onPulsar ? texto : `${texto} (todavía sin función)`}
      onClick={activo && onPulsar ? onPulsar : undefined}
      aria-disabled={apagado || undefined}
      onPointerEnter={() => setEncima(true)}
      onPointerLeave={() => setEncima(false)}
      style={{
        // Llena la caja del widget: el tamaño se decide estirándolo en el
        // lienzo, como cualquier otro.
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        padding: '0 12px',
        border: `1px solid ${primario ? C.verde : C.borde}`,
        borderRadius: 7,
        background: fondo,
        color: primario ? '#fff' : peligro ? C.rojo : C.tinta,
        fontSize: 13,
        fontWeight: peligro ? 700 : 600,
        fontFamily: FUENTE,
        cursor: !ctx.interactivo ? 'default' : apagado ? 'not-allowed' : 'pointer',
        opacity: apagado ? 0.55 : 1,
        transition: 'background .12s, opacity .12s',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <Icono style={{ width: 15, height: 15, flexShrink: 0 }} />
      {texto}
      {extra}
    </button>
  );
}

// ─── La ventana ──────────────────────────────────────────────────
//
// Una sola para los dos botones. «Nueva receta» la abre sin opciones (solo
// crear); «Guardar receta» la abre con las dos.

const mismoNombre = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function Opcion({
  elegida,
  apagada,
  titulo,
  detalle,
  onElegir,
}: {
  elegida: boolean;
  apagada?: boolean;
  titulo: string;
  detalle: string;
  onElegir: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={elegida}
      disabled={apagada}
      onClick={onElegir}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        boxSizing: 'border-box',
        padding: '11px 14px',
        marginTop: 8,
        border: `1px solid ${elegida ? C.verde : C.borde}`,
        borderLeft: `${elegida ? 4 : 1}px solid ${elegida ? C.verde : C.borde}`,
        borderRadius: 6,
        background: elegida ? C.seleccion : '#fff',
        color: C.tinta,
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: apagada ? 'not-allowed' : 'pointer',
        opacity: apagada ? 0.5 : 1,
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          boxSizing: 'border-box',
          borderRadius: '50%',
          border: `1.5px solid ${elegida ? C.verde : C.suave}`,
          background: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {elegida && (
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.verde }} />
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>{titulo}</span>
        <span style={{ display: 'block', fontSize: 12, color: C.suave, marginTop: 1 }}>
          {detalle}
        </span>
      </span>
    </button>
  );
}

const estiloBotonVentana = (primario: boolean, apagado: boolean): React.CSSProperties => ({
  height: 38,
  padding: '0 18px',
  border: `1px solid ${primario ? C.verde : C.borde}`,
  borderRadius: 7,
  background: primario ? C.verde : C.fondo,
  color: primario ? '#fff' : C.tinta,
  fontSize: 13.5,
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: apagado ? 'not-allowed' : 'pointer',
  opacity: apagado ? 0.5 : 1,
});

function VentanaReceta({
  recetaId,
  recetaNombre,
  conOpciones,
  onCerrar,
}: {
  recetaId: number;
  recetaNombre: string;
  /** `true` = «Guardar receta» (dos opciones). `false` = «Nueva receta». */
  conOpciones: boolean;
  onCerrar: () => void;
}) {
  // La receta actual, tal como está al abrir: es la que se ofrece modificar.
  const [actual] = useState(() => recetaActual(recetaId));
  const [modo, setModo] = useState<'actual' | 'crear'>(
    conOpciones && actual ? 'actual' : 'crear'
  );
  const [nombre, setNombre] = useState('');
  const [registros, setRegistros] = useState<RegistroExistente[]>([]);
  const [fallo, setFallo] = useState('');
  const [avisos, setAvisos] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const entrada = useRef<HTMLInputElement>(null);
  // Cuántos valores se van a guardar, tal como está la pantalla al abrir.
  const [cuantos] = useState(() => valoresEnPantalla(recetaId).size);
  // «Guardar receta» también envía al PLC lo escrito y sin enviar.
  const [porEnviar] = useState(() => (conOpciones ? pendientesDeEnviar(recetaId) : 0));
  // Ya se guardó, pero algo no se pudo enviar: la ventana se queda para decirlo.
  const [hecho, setHecho] = useState<{ nombre: string; envio: ResultadoEnvio } | null>(null);

  // Los nombres que ya existen, para avisar ANTES de pulsar Guardar. Si no
  // se pueden leer no pasa nada: el guardado lo vuelve a comprobar.
  useEffect(() => {
    let vivo = true;
    listarRegistros(recetaId)
      .then((l) => vivo && setRegistros(l))
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [recetaId]);

  useEffect(() => {
    if (modo === 'crear') entrada.current?.focus();
  }, [modo]);

  const limpio = nombre.trim();
  const repetido =
    modo === 'crear' && limpio !== '' && registros.some((r) => mismoNombre(r.nombre, limpio));
  const noSePuede = ocupado || (modo === 'crear' && (!limpio || repetido));

  const confirmar = async () => {
    if (noSePuede) return;
    setOcupado(true);
    setFallo('');
    setAvisos([]);
    const r = await guardarDataRecord(recetaId, nombre, modo, conOpciones);
    setOcupado(false);
    if (r.ok) {
      // Todo fue bien: se cierra. Si algo no se envió al PLC, se queda
      // abierta enseñándolo — la receta ya está guardada igualmente.
      if (r.envio && r.envio.fallos.length > 0) {
        setHecho({ nombre: r.nombre ?? '', envio: r.envio });
      } else {
        onCerrar();
      }
      return;
    }
    setFallo(r.error ?? 'No se pudo guardar.');
    setAvisos(r.avisos ?? []);
  };

  const titulo = conOpciones ? 'Guardar receta' : 'Nueva receta';

  return createPortal(
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !ocupado) onCerrar();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !ocupado) onCerrar();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(15,23,42,.45)',
        fontFamily: FUENTE,
      }}
    >
      <div
        role="dialog"
        aria-label={titulo}
        style={{
          width: 520,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 32px)',
          overflow: 'auto',
          boxSizing: 'border-box',
          background: '#f8fafb',
          color: C.tinta,
          borderRadius: 12,
          boxShadow: '0 24px 70px rgba(0,0,0,.38)',
          padding: '22px 24px 20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.4, color: C.verde }}>
              GESTIÓN DE RECETAS
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 3 }}>{titulo}</div>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            disabled={ocupado}
            onClick={onCerrar}
            style={{
              border: 'none',
              background: 'transparent',
              color: C.suave,
              cursor: 'pointer',
              padding: 4,
              marginTop: 6,
            }}
          >
            <XIcon style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {hecho ? (
          <>
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                borderRadius: 6,
                background: C.seleccion,
                borderLeft: `4px solid ${C.verde}`,
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              <b>Receta «{hecho.nombre}» guardada.</b>
              {hecho.envio.enviados > 0 && (
                <div>
                  {hecho.envio.enviados} valor{hecho.envio.enviados === 1 ? '' : 'es'} enviado
                  {hecho.envio.enviados === 1 ? '' : 's'} al PLC.
                </div>
              )}
            </div>
            <div
              style={{
                marginTop: 10,
                padding: '10px 12px',
                borderRadius: 6,
                background: '#fdf3dc',
                borderLeft: `4px solid ${C.ambar}`,
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            >
              <b>
                {hecho.envio.fallos.length === 1
                  ? 'Un valor no se envió al PLC:'
                  : `${hecho.envio.fallos.length} valores no se enviaron al PLC:`}
              </b>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {hecho.envio.fallos.map((f, i) => (
                  <li key={i}>
                    <b>{f.nombre}</b>: {f.motivo}.
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 6, color: C.suave }}>
                Siguen marcados en ámbar. Están guardados en la receta, pero el PLC no los tiene.
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginTop: 18,
                paddingTop: 16,
                borderTop: `1px solid ${C.franja}`,
              }}
            >
              <button type="button" onClick={onCerrar} style={estiloBotonVentana(true, false)}>
                Entendido
              </button>
            </div>
          </>
        ) : (
          <>
        <div style={{ fontSize: 13, color: C.suave, lineHeight: 1.5, marginTop: 10 }}>
          {conOpciones
            ? 'Actualiza la receta actual o guarda los valores con otro nombre. Los valores que cambiaste y aún no enviaste también se envían al PLC.'
            : 'Crea una receta con los valores que hay en los campos. No se envía nada al PLC.'}
          {recetaNombre && (
            <>
              {' '}
              Se guarda en <b style={{ color: C.tinta }}>{recetaNombre}</b>.
            </>
          )}
        </div>

        {conOpciones && (
          <div role="radiogroup" style={{ marginTop: 8 }}>
            <Opcion
              elegida={modo === 'actual'}
              apagada={!actual || ocupado}
              titulo="Modificar receta actual"
              detalle={actual ? actual.nombre : 'Todavía no hay una receta actual'}
              onElegir={() => {
                setModo('actual');
                setFallo('');
                setAvisos([]);
              }}
            />
            <Opcion
              elegida={modo === 'crear'}
              apagada={ocupado}
              titulo="Guardar como nueva"
              detalle="Conservar la original y crear otra receta"
              onElegir={() => {
                setModo('crear');
                setFallo('');
                setAvisos([]);
              }}
            />
          </div>
        )}

        <label style={{ display: 'block', marginTop: 16 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
            Nombre de la receta
          </span>
          <input
            ref={entrada}
            // Al modificar la actual el nombre no se cambia: solo se enseña.
            value={modo === 'actual' ? actual?.nombre ?? '' : nombre}
            readOnly={modo === 'actual' || ocupado}
            onChange={(e) => setNombre(e.target.value)}
            // Enter confirma solo desde aquí: en toda la ventana, pulsarlo
            // sobre una de las opciones la elegiría Y guardaría de golpe.
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmar();
            }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              height: 42,
              padding: '0 12px',
              border: `1px solid ${repetido ? C.ambar : C.borde}`,
              borderRadius: 6,
              fontSize: 15,
              fontFamily: 'inherit',
              color: C.tinta,
              background: modo === 'actual' ? C.campoApagado : '#fff',
              outline: 'none',
            }}
          />
        </label>

        {repetido && (
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: C.ambar }}>
            Ya existe una receta llamada «{limpio}». Usa otro nombre
            {conOpciones ? ', o elige «Modificar receta actual» para escribir encima.' : '.'}
          </div>
        )}

        <div style={{ marginTop: 8, fontSize: 12, color: C.suave }}>
          {cuantos} parámetro{cuantos === 1 ? '' : 's'} · Solo se guardan los valores blancos.
        </div>

        {conOpciones && (
          <div
            style={{
              marginTop: 8,
              padding: '7px 10px',
              borderRadius: 6,
              background: porEnviar > 0 ? '#fdf3dc' : C.franja,
              borderLeft: `4px solid ${porEnviar > 0 ? C.ambar : C.borde}`,
              fontSize: 12,
              color: C.tinta,
            }}
          >
            {porEnviar > 0
              ? `Al guardar se ${porEnviar === 1 ? 'enviará 1 valor' : `enviarán ${porEnviar} valores`} al PLC (los campos marcados en ámbar).`
              : 'No hay valores pendientes de enviar al PLC.'}
          </div>
        )}

        {fallo && (
          <div
            style={{
              marginTop: 12,
              padding: '9px 12px',
              borderRadius: 6,
              background: avisos.length > 0 ? '#fdf3dc' : '#fdeaec',
              borderLeft: `4px solid ${avisos.length > 0 ? C.ambar : C.rojo}`,
              color: C.tinta,
              fontSize: 12.5,
              lineHeight: 1.45,
            }}
          >
            <b>{fallo}</b>
            {avisos.length > 0 && (
              <>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {avisos.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
                <div style={{ marginTop: 4 }}>No se guardó nada.</div>
              </>
            )}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            marginTop: 18,
            paddingTop: 16,
            borderTop: `1px solid ${C.franja}`,
          }}
        >
          <button
            type="button"
            disabled={ocupado}
            onClick={onCerrar}
            style={estiloBotonVentana(false, ocupado)}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={noSePuede}
            onClick={() => void confirmar()}
            style={estiloBotonVentana(true, noSePuede)}
          >
            {ocupado ? 'Guardando…' : conOpciones ? 'Guardar' : 'Crear receta'}
          </button>
        </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

// ─── Lo común de «Nueva» y «Guardar» ─────────────────────────────

const SIN_RECETA =
  'Este botón no tiene receta: en el Diseñador, marca «Habilitar receta» y elige una.';

// ─── «Nueva receta» ──────────────────────────────────────────────

function NuevaReceta(ctx: RenderCtx) {
  const cfg = leerCfgReceta(ctx.widget);
  const recetaId = cfg.habilitada ? cfg.id : null;
  const [abierta, setAbierta] = useState(false);

  const pulsar = () => {
    if (!recetaId) {
      notificar(SIN_RECETA, 'aviso');
      return;
    }
    // Primero se guarda lo que se cambió. Solo si hay una receta actual:
    // sin ella no hay «dónde guardar primero», y crear ES guardar.
    const cargada = recetaActual(recetaId);
    if (cargada && hayCambiosSinGuardar(recetaId)) {
      notificar(
        `Hay cambios sin guardar en «${cargada.nombre}». Guárdalos primero con «Guardar receta» y después crea la nueva.`,
        'aviso'
      );
      return;
    }
    setAbierta(true);
  };

  return (
    <>
      <BotonReceta ctx={ctx} texto="Nueva receta" Icono={PlusIcon} onPulsar={pulsar} />

      {abierta && recetaId && (
        <VentanaReceta
          recetaId={recetaId}
          recetaNombre={cfg.nombre}
          conOpciones={false}
          onCerrar={() => setAbierta(false)}
        />
      )}
    </>
  );
}

// ─── «Guardar receta» ────────────────────────────────────────────

function GuardarReceta(ctx: RenderCtx) {
  const cfg = leerCfgReceta(ctx.widget);
  const recetaId = cfg.habilitada ? cfg.id : null;
  const [abierta, setAbierta] = useState(false);

  return (
    <>
      <BotonReceta
        ctx={ctx}
        texto="Guardar receta"
        Icono={CheckIcon}
        primario
        onPulsar={() => (recetaId ? setAbierta(true) : notificar(SIN_RECETA, 'aviso'))}
      />

      {abierta && recetaId && (
        <VentanaReceta
          recetaId={recetaId}
          recetaNombre={cfg.nombre}
          conOpciones
          onCerrar={() => setAbierta(false)}
        />
      )}
    </>
  );
}

// ─── «Cargar receta» ─────────────────────────────────────────────

/** «1 campo» / «3 campos». */
function plural(n: number, uno: string, varios: string): string {
  return n === 1 ? `1 ${uno}` : `${n} ${varios}`;
}

function VentanaCargar({
  recetaId,
  recetaNombre,
  onCerrar,
  onCargada,
}: {
  recetaId: number;
  recetaNombre: string;
  onCerrar: () => void;
  /** Se cargó y se envió todo: el aviso lo enseña el botón. */
  onCargada: (r: ResultadoCargar) => void;
}) {
  const [actual] = useState(() => recetaActual(recetaId));
  const [registros, setRegistros] = useState<RegistroExistente[] | null>(null);
  const [elegida, setElegida] = useState<number | null>(null);
  const [fallo, setFallo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [hecho, setHecho] = useState<ResultadoCargar | null>(null);

  useEffect(() => {
    let vivo = true;
    listarRegistros(recetaId)
      .then((l) => vivo && setRegistros(l))
      .catch((e: any) => {
        if (!vivo) return;
        setRegistros([]);
        setFallo(`No se pudieron leer las recetas: ${e?.message ?? 'la base de datos no responde'}.`);
      });
    return () => {
      vivo = false;
    };
  }, [recetaId]);

  const registro = (registros ?? []).find((r) => r.id === elegida) ?? null;
  const noSePuede = ocupado || !registro;

  const confirmar = async () => {
    if (noSePuede || !registro) return;
    setOcupado(true);
    setFallo('');
    const r = await cargarDataRecord(recetaId, registro);
    setOcupado(false);
    if (!r.ok) {
      setFallo(r.error ?? 'No se pudo cargar la receta.');
      return;
    }
    // Todo enviado: se cierra y el botón lo confirma. Si algo no llegó al
    // PLC, la ventana se queda para decir cuál y por qué.
    if (r.envio && r.envio.fallos.length > 0) setHecho(r);
    else {
      onCargada(r);
      onCerrar();
    }
  };

  return createPortal(
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !ocupado) onCerrar();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !ocupado) onCerrar();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(15,23,42,.45)',
        fontFamily: FUENTE,
      }}
    >
      <div
        role="dialog"
        aria-label="Cargar receta"
        style={{
          width: 520,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 32px)',
          overflow: 'auto',
          boxSizing: 'border-box',
          background: '#f8fafb',
          color: C.tinta,
          borderRadius: 12,
          boxShadow: '0 24px 70px rgba(0,0,0,.38)',
          padding: '22px 24px 20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.4, color: C.verde }}>
              GESTIÓN DE RECETAS
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 3 }}>Cargar receta</div>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            disabled={ocupado}
            onClick={onCerrar}
            style={{
              border: 'none',
              background: 'transparent',
              color: C.suave,
              cursor: 'pointer',
              padding: 4,
              marginTop: 6,
            }}
          >
            <XIcon style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {hecho ? (
          <>
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                borderRadius: 6,
                background: C.seleccion,
                borderLeft: `4px solid ${C.verde}`,
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              <b>Receta «{hecho.nombre}» cargada.</b>
              <div>
                {plural(hecho.cargados ?? 0, 'campo cargado', 'campos cargados')}
                {' · '}
                {plural(hecho.envio?.enviados ?? 0, 'valor enviado', 'valores enviados')} al PLC.
              </div>
            </div>
            <div
              style={{
                marginTop: 10,
                padding: '10px 12px',
                borderRadius: 6,
                background: '#fdf3dc',
                borderLeft: `4px solid ${C.ambar}`,
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            >
              <b>
                {(hecho.envio?.fallos.length ?? 0) === 1
                  ? 'Un valor no se envió al PLC:'
                  : `${hecho.envio?.fallos.length} valores no se enviaron al PLC:`}
              </b>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {(hecho.envio?.fallos ?? []).map((f, i) => (
                  <li key={i}>
                    <b>{f.nombre}</b>: {f.motivo}.
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 6, color: C.suave }}>
                Están en su campo, marcados en ámbar: el PLC todavía no los tiene.
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginTop: 18,
                paddingTop: 16,
                borderTop: `1px solid ${C.franja}`,
              }}
            >
              <button type="button" onClick={onCerrar} style={estiloBotonVentana(true, false)}>
                Entendido
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: C.suave, lineHeight: 1.5, marginTop: 10 }}>
              Elige la receta que quieres cargar
              {recetaNombre && (
                <>
                  {' '}
                  de <b style={{ color: C.tinta }}>{recetaNombre}</b>
                </>
              )}
              . Sus valores se ponen en los campos blancos de esta pantalla.
            </div>

            <div
              role="radiogroup"
              style={{
                marginTop: 12,
                maxHeight: 260,
                overflow: 'auto',
                border: `1px solid ${C.borde}`,
                borderRadius: 6,
                background: '#fff',
              }}
            >
              {registros === null ? (
                <div style={{ padding: 14, fontSize: 13, color: C.suave }}>Leyendo recetas…</div>
              ) : registros.length === 0 ? (
                <div style={{ padding: 14, fontSize: 13, color: C.suave, lineHeight: 1.5 }}>
                  Todavía no hay ninguna receta guardada. Créala con «Nueva receta».
                </div>
              ) : (
                registros.map((r) => {
                  const esElegida = r.id === elegida;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="radio"
                      aria-checked={esElegida}
                      disabled={ocupado}
                      onClick={() => {
                        setElegida(r.id);
                        setFallo('');
                      }}
                      onDoubleClick={() => void confirmar()}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '10px 14px',
                        border: 'none',
                        borderBottom: `1px solid ${C.franja}`,
                        borderLeft: `4px solid ${esElegida ? C.verde : 'transparent'}`,
                        background: esElegida ? C.seleccion : 'transparent',
                        color: C.tinta,
                        fontFamily: 'inherit',
                        fontSize: 14,
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          flexShrink: 0,
                          boxSizing: 'border-box',
                          borderRadius: '50%',
                          border: `1.5px solid ${esElegida ? C.verde : C.suave}`,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {esElegida && (
                          <span
                            style={{ width: 8, height: 8, borderRadius: '50%', background: C.verde }}
                          />
                        )}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
                        {r.nombre || '(sin nombre)'}
                      </span>
                      {actual?.registroId === r.id && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: 0.6,
                            color: C.verde,
                          }}
                        >
                          ACTUAL
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            <div
              style={{
                marginTop: 10,
                padding: '7px 10px',
                borderRadius: 6,
                background: '#fdf3dc',
                borderLeft: `4px solid ${C.ambar}`,
                fontSize: 12,
              }}
            >
              Al cargar se enviarán los valores al PLC.
            </div>

            {fallo && (
              <div
                style={{
                  marginTop: 10,
                  padding: '9px 12px',
                  borderRadius: 6,
                  background: '#fdeaec',
                  borderLeft: `4px solid ${C.rojo}`,
                  fontSize: 12.5,
                  lineHeight: 1.45,
                }}
              >
                <b>{fallo}</b>
              </div>
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 10,
                marginTop: 18,
                paddingTop: 16,
                borderTop: `1px solid ${C.franja}`,
              }}
            >
              <button
                type="button"
                disabled={ocupado}
                onClick={onCerrar}
                style={estiloBotonVentana(false, ocupado)}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={noSePuede}
                onClick={() => void confirmar()}
                style={estiloBotonVentana(true, noSePuede)}
              >
                {ocupado ? 'Cargando…' : 'Cargar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

/**
 * El bloque «RECETA ACTUAL», a la derecha del botón «Cargar receta».
 *
 * Misma altura que el botón y en su misma fila, para que se lea como parte
 * de la botonera. El estado sale de lo que el operario haya tocado: en
 * cuanto cambia un campo pasa a «Sin guardar», y vuelve a «Guardada» al
 * guardar o al cargar.
 */
function BloqueRecetaActual({
  recetaId,
  alto,
  atenuado,
}: {
  recetaId: number | null;
  alto: number;
  /** En el Diseñador: se enseña para reservarle sitio, pero no es real. */
  atenuado?: boolean;
}) {
  const { actual, sinGuardar } = useEstadoReceta(recetaId);
  const chip = !actual
    ? null
    : sinGuardar
      ? { texto: 'Sin guardar', fondo: '#fdf0cf', tinta: '#8a5a00', punto: C.ambar }
      : { texto: 'Guardada', fondo: '#d9efe6', tinta: C.verde, punto: C.verde };

  return (
    <div
      style={{
        height: Math.max(alto, 34),
        minWidth: 250,
        maxWidth: 440,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 10px 0 12px',
        background: C.fondo,
        border: `1px solid ${C.borde}`,
        borderLeft: `4px solid ${sinGuardar ? C.ambar : C.verde}`,
        borderRadius: 7,
        fontFamily: FUENTE,
        opacity: atenuado ? 0.6 : 1,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: 0.9,
            lineHeight: 1.1,
            color: C.suave,
          }}
        >
          RECETA ACTUAL
        </div>
        <div
          title={actual?.nombre}
          style={{
            marginTop: 2,
            fontSize: 13.5,
            fontWeight: 700,
            lineHeight: 1.15,
            color: actual ? C.tinta : C.suave,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {actual ? actual.nombre : 'Sin receta seleccionada'}
        </div>
      </div>

      {chip && (
        <span
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 22,
            padding: '0 9px',
            borderRadius: 5,
            background: chip.fondo,
            color: chip.tinta,
            fontSize: 11.5,
            fontWeight: 700,
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{ width: 6, height: 6, borderRadius: '50%', background: chip.punto }}
          />
          {chip.texto}
        </span>
      )}
    </div>
  );
}

function CargarReceta(ctx: RenderCtx) {
  const cfg = leerCfgReceta(ctx.widget);
  const recetaId = cfg.habilitada ? cfg.id : null;
  const [abierta, setAbierta] = useState(false);
  const boton = useRef<HTMLButtonElement>(null);

  const pulsar = () => {
    if (!recetaId) {
      notificar(SIN_RECETA, 'aviso');
      return;
    }
    // Cargar pisaría lo escrito: primero se guarda.
    const cargada = recetaActual(recetaId);
    if (cargada && hayCambiosSinGuardar(recetaId)) {
      notificar(
        `Hay cambios sin guardar en «${cargada.nombre}». Guárdalos primero con «Guardar receta» y después carga la otra.`,
        'aviso'
      );
      return;
    }
    setAbierta(true);
  };

  return (
    <>
      <BotonReceta
        ctx={ctx}
        texto="Cargar receta"
        Icono={UploadIcon}
        refBoton={boton}
        onPulsar={pulsar}
      />

      {abierta && recetaId && (
        <VentanaCargar
          recetaId={recetaId}
          recetaNombre={cfg.nombre}
          onCerrar={() => setAbierta(false)}
          onCargada={(r) =>
            notificar(
              `Receta «${r.nombre}» cargada: ${plural(r.cargados ?? 0, 'campo', 'campos')}` +
                ((r.envio?.enviados ?? 0) > 0
                  ? `, ${plural(r.envio!.enviados, 'valor enviado', 'valores enviados')} al PLC.`
                  : '. El PLC ya tenía esos valores.'),
              'ok'
            )
          }
        />
      )}

      {/* A la derecha del botón, siempre. También en el Diseñador, atenuado:
          no ocupa sitio en el diseño, así que hay que VERLO para dejarle
          hueco y que no caiga encima de otro widget. */}
      <BajoWidget ancla={boton} lado="derecha" separacion={12}>
        {(_ancho, alto) => (
          <BloqueRecetaActual recetaId={recetaId} alto={alto} atenuado={!ctx.interactivo} />
        )}
      </BajoWidget>
    </>
  );
}

// ─── «Eliminar receta» ───────────────────────────────────────────

/** «Guardada el 7/10/26, 2:43 p. m.». Vacío si la fecha no se entiende. */
function cuandoSeGuardo(fecha?: string): string {
  if (!fecha) return '';
  const d = new Date(fecha.includes('T') ? fecha : fecha.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return `Guardada el ${d.toLocaleString('es-PE', {
    day: 'numeric',
    month: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

const estiloBotonRojo = (apagado: boolean): React.CSSProperties => ({
  ...estiloBotonVentana(true, apagado),
  background: C.rojo,
  border: `1px solid ${C.rojo}`,
});

function VentanaEliminar({ recetaId, onCerrar }: { recetaId: number; onCerrar: () => void }) {
  const [actual] = useState(() => recetaActual(recetaId));
  const [registros, setRegistros] = useState<RegistroExistente[] | null>(null);
  const [elegida, setElegida] = useState<number | null>(null);
  // Segundo paso: confirmar. Borrar no se deshace, así que no basta un clic.
  const [confirmando, setConfirmando] = useState(false);
  const [fallo, setFallo] = useState('');
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vivo = true;
    listarRegistros(recetaId)
      .then((l) => vivo && setRegistros(l))
      .catch((e: any) => {
        if (!vivo) return;
        setRegistros([]);
        setFallo(`No se pudieron leer las recetas: ${e?.message ?? 'la base de datos no responde'}.`);
      });
    return () => {
      vivo = false;
    };
  }, [recetaId]);

  const registro = (registros ?? []).find((r) => r.id === elegida) ?? null;
  const esLaActual = !!registro && actual?.registroId === registro.id;

  const eliminar = async () => {
    if (!registro || ocupado) return;
    setOcupado(true);
    setFallo('');
    const r = await eliminarDataRecord(recetaId, registro);
    setOcupado(false);
    if (!r.ok) {
      setFallo(r.error ?? 'No se pudo eliminar la receta.');
      setConfirmando(false);
      return;
    }
    notificar(`Receta «${registro.nombre}» eliminada.`, 'ok');
    onCerrar();
  };

  const pie: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 18,
    paddingTop: 16,
    borderTop: `1px solid ${C.franja}`,
  };

  return createPortal(
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !ocupado) onCerrar();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !ocupado) onCerrar();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(15,23,42,.45)',
        fontFamily: FUENTE,
      }}
    >
      <div
        role="dialog"
        aria-label="Eliminar receta"
        style={{
          width: 520,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 32px)',
          overflow: 'auto',
          boxSizing: 'border-box',
          background: '#f8fafb',
          color: C.tinta,
          borderRadius: 12,
          boxShadow: '0 24px 70px rgba(0,0,0,.38)',
          padding: '22px 24px 20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.4, color: C.verde }}>
              GESTIÓN DE RECETAS
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 3 }}>Eliminar receta</div>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            disabled={ocupado}
            onClick={onCerrar}
            style={{
              border: 'none',
              background: 'transparent',
              color: C.suave,
              cursor: 'pointer',
              padding: 4,
              marginTop: 6,
            }}
          >
            <XIcon style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {confirmando && registro ? (
          <>
            <div
              style={{
                marginTop: 14,
                padding: '12px 14px',
                borderRadius: 6,
                background: '#fdeaec',
                borderLeft: `4px solid ${C.rojo}`,
                fontSize: 13.5,
                lineHeight: 1.5,
              }}
            >
              <b>¿Eliminar «{registro.nombre}»?</b>
              <div>Se borra con todos sus valores y no se puede deshacer.</div>
              {esLaActual && (
                <div style={{ marginTop: 6 }}>
                  Es la <b>receta actual</b>: al eliminarla la pantalla queda sin receta
                  seleccionada. Los valores de los campos no se tocan.
                </div>
              )}
            </div>
            <div style={pie}>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => setConfirmando(false)}
                style={estiloBotonVentana(false, ocupado)}
              >
                Volver
              </button>
              <button
                type="button"
                disabled={ocupado}
                onClick={() => void eliminar()}
                style={estiloBotonRojo(ocupado)}
              >
                {ocupado ? 'Eliminando…' : 'Eliminar'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: C.suave, lineHeight: 1.5, marginTop: 10 }}>
              Selecciona la receta guardada que deseas eliminar.
            </div>

            <div role="radiogroup" style={{ marginTop: 6, maxHeight: 300, overflow: 'auto' }}>
              {registros === null ? (
                <div style={{ padding: '14px 2px', fontSize: 13, color: C.suave }}>
                  Leyendo recetas…
                </div>
              ) : registros.length === 0 ? (
                <div style={{ padding: '14px 2px', fontSize: 13, color: C.suave }}>
                  No hay ninguna receta guardada.
                </div>
              ) : (
                registros.map((r) => (
                  <Opcion
                    key={r.id}
                    elegida={r.id === elegida}
                    titulo={r.nombre || '(sin nombre)'}
                    detalle={
                      [cuandoSeGuardo(r.fecha), actual?.registroId === r.id ? 'Receta actual' : '']
                        .filter(Boolean)
                        .join(' · ') || `Receta n.º ${r.numero}`
                    }
                    onElegir={() => {
                      setElegida(r.id);
                      setFallo('');
                    }}
                  />
                ))
              )}
            </div>

            {fallo && (
              <div
                style={{
                  marginTop: 10,
                  padding: '9px 12px',
                  borderRadius: 6,
                  background: '#fdeaec',
                  borderLeft: `4px solid ${C.rojo}`,
                  fontSize: 12.5,
                  lineHeight: 1.45,
                }}
              >
                <b>{fallo}</b>
              </div>
            )}

            <div style={pie}>
              <button type="button" onClick={onCerrar} style={estiloBotonVentana(false, false)}>
                Cancelar
              </button>
              <button
                type="button"
                disabled={!registro}
                onClick={() => setConfirmando(true)}
                style={estiloBotonRojo(!registro)}
              >
                Continuar
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

function EliminarReceta(ctx: RenderCtx) {
  const cfg = leerCfgReceta(ctx.widget);
  const recetaId = cfg.habilitada ? cfg.id : null;
  const [abierta, setAbierta] = useState(false);

  return (
    <>
      <BotonReceta
        ctx={ctx}
        texto="Eliminar receta"
        Icono={XIcon}
        peligro
        onPulsar={() => (recetaId ? setAbierta(true) : notificar(SIN_RECETA, 'aviso'))}
      />
      {abierta && recetaId && (
        <VentanaEliminar recetaId={recetaId} onCerrar={() => setAbierta(false)} />
      )}
    </>
  );
}

// ─── «Aplicar todos» ─────────────────────────────────────────────

/**
 * Envía al PLC, uno por uno, todos los campos en ámbar de la receta que hay
 * en esta pantalla. SOLO al PLC: no toca el data record. Para la receta
 * siguen siendo cambios sin guardar («Guardar receta» es lo que guarda).
 *
 * Lleva la cuenta de pendientes y se apaga cuando no hay ninguno.
 */
function AplicarTodos(ctx: RenderCtx) {
  const cfg = leerCfgReceta(ctx.widget);
  const recetaId = cfg.habilitada ? cfg.id : null;
  const pendientes = usePendientesDeEnviar(recetaId);
  const [enviando, setEnviando] = useState(false);

  const pulsar = async () => {
    if (!recetaId) {
      notificar(SIN_RECETA, 'aviso');
      return;
    }
    if (enviando) return;
    const total = pendientesDeEnviar(recetaId);
    if (total === 0) {
      notificar('No hay cambios por aplicar.', 'aviso');
      return;
    }
    setEnviando(true);
    try {
      const r = await enviarPendientes(recetaId);
      if (r.fallos.length === 0) {
        notificar(
          r.enviados === 1
            ? 'Se envió 1 valor al PLC.'
            : `Se enviaron ${r.enviados} valores al PLC.`,
          'ok'
        );
        return;
      }
      const detalle = r.fallos.map((f) => `«${f.nombre}»: ${f.motivo}`).join(' · ');
      notificar(
        r.enviados > 0
          ? `Se enviaron ${r.enviados} de ${r.enviados + r.fallos.length}. No se enviaron (siguen en ámbar): ${detalle}.`
          : `No se envió ningún valor (siguen en ámbar): ${detalle}.`,
        r.enviados > 0 ? 'aviso' : 'error',
        9000
      );
    } finally {
      setEnviando(false);
    }
  };

  // En el Diseñador se ve normal, sin cuenta: ahí no se escribe nada.
  const conCuenta = !!ctx.interactivo && pendientes > 0;
  return (
    <BotonReceta
      ctx={ctx}
      texto={enviando ? 'Enviando…' : 'Aplicar todos'}
      Icono={SendIcon}
      apagado={!!ctx.interactivo && (enviando || pendientes === 0)}
      onPulsar={() => void pulsar()}
      extra={
        conCuenta && !enviando ? (
          <span
            title={`${pendientes} ${pendientes === 1 ? 'valor' : 'valores'} por enviar al PLC`}
            style={{
              minWidth: 20,
              height: 20,
              padding: '0 6px',
              boxSizing: 'border-box',
              borderRadius: 10,
              background: C.ambar,
              color: '#fff',
              fontSize: 11.5,
              fontWeight: 700,
              lineHeight: '20px',
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {pendientes}
          </span>
        ) : undefined
      }
    />
  );
}

// ─── El contador ─────────────────────────────────────────────────

/**
 * «2 recetas guardadas»: cuántos data records tiene la receta elegida.
 *
 * Sin fondo propio y con los colores del widget, para que se lea igual
 * sobre una pantalla clara que sobre una oscura: el número toma el color de
 * Apariencia y el rótulo va en un gris que aguanta los dos fondos.
 */
function ContadorRecetas(ctx: RenderCtx) {
  const cfg = leerCfgReceta(ctx.widget);
  const recetaId = cfg.habilitada ? cfg.id : null;
  const conteo = useConteoRecetas(recetaId);
  const alto = ctx.widget.height || 44;
  const tamNumero = Math.max(18, Math.min(56, Math.round(alto * 0.72)));

  return (
    <div
      title={
        recetaId
          ? `Recetas guardadas en ${cfg.nombre || 'la receta elegida'}`
          : 'Marca «Habilitar receta» y elige una en el Inspector'
      }
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 4px',
        fontFamily: FUENTE,
        overflow: 'hidden',
      }}
    >
      <strong
        style={{
          fontSize: tamNumero,
          fontWeight: 700,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          color: ctx.style.color || C.verde,
        }}
      >
        {conteo === null ? '—' : conteo}
      </strong>
      <span
        style={{
          fontSize: Math.max(10.5, Math.min(14, tamNumero * 0.4)),
          lineHeight: 1.3,
          color: '#8496a3',
        }}
      >
        {conteo === 1 ? 'receta' : 'recetas'}
        <br />
        {conteo === 1 ? 'guardada' : 'guardadas'}
      </span>
    </div>
  );
}

const base = {
  category: 'Recetas',
  defaultHeight: 38,
} as const;

export const recetaNueva: CustomWidgetDef = {
  ...base,
  kind: 'custom:receta-nueva',
  label: 'Nueva receta',
  icon: PlusIcon,
  defaultWidth: 140,
  render: (ctx) => <NuevaReceta {...ctx} />,
};

export const recetaGuardar: CustomWidgetDef = {
  ...base,
  kind: 'custom:receta-guardar',
  label: 'Guardar receta',
  icon: CheckIcon,
  defaultWidth: 150,
  render: (ctx) => <GuardarReceta {...ctx} />,
};

export const recetaCargar: CustomWidgetDef = {
  ...base,
  kind: 'custom:receta-cargar',
  label: 'Cargar receta',
  icon: UploadIcon,
  defaultWidth: 142,
  render: (ctx) => <CargarReceta {...ctx} />,
};

export const recetaEliminar: CustomWidgetDef = {
  ...base,
  kind: 'custom:receta-eliminar',
  label: 'Eliminar receta',
  icon: XIcon,
  defaultWidth: 152,
  render: (ctx) => <EliminarReceta {...ctx} />,
};

export const recetaAplicar: CustomWidgetDef = {
  ...base,
  kind: 'custom:receta-aplicar',
  label: 'Aplicar todos',
  icon: SendIcon,
  defaultWidth: 170,
  render: (ctx) => <AplicarTodos {...ctx} />,
};

export const recetaContador: CustomWidgetDef = {
  ...base,
  kind: 'custom:receta-contador',
  label: 'Contador de recetas',
  icon: ListOrderedIcon,
  defaultWidth: 170,
  defaultHeight: 46,
  render: (ctx) => <ContadorRecetas {...ctx} />,
};
