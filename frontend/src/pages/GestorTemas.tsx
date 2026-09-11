// =========================================================================
// GestorTemas.tsx  —  el Gestor de Temas
//
// Paleta y tipografías del proyecto, al modo del Theme Manager de WebIQ:
// varios temas, cada uno con su juego de colores CLARO y OSCURO, sus fuentes,
// y un modo por defecto.
//
// LO QUE SE EDITA AQUÍ NO SE GUARDA HASTA QUE SE PULSA GUARDAR
// Todo el trabajo ocurre sobre un borrador en memoria, y la vista previa
// aplica ese borrador al documento entero para que se vea de verdad —no en
// una maqueta de mentira dentro de un recuadro—. Salir sin guardar lo
// descarta y devuelve los colores de verdad: de eso se encarga el efecto de
// limpieza del final.
//
// POR QUÉ SE GUARDA LA LISTA ENTERA Y NO EL TEMA QUE SE TOCÓ
// Porque aquí se hacen varias cosas de golpe (duplicar uno, renombrar otro,
// cambiar cuál está activo) y partirlo en varias escrituras dejaría estados
// intermedios visibles para los demás clientes: durante un instante habría un
// tema activo que aún no existe.
// =========================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  PaletteIcon,
  PlusIcon,
  CopyIcon,
  Trash2Icon,
  DownloadIcon,
  UploadIcon,
  SaveIcon,
  SunIcon,
  MoonIcon,
  TypeIcon,
  RotateCcwIcon,
  AlertTriangleIcon,
  CheckIcon,
  PencilIcon,
  Link2Icon,
} from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { useTema } from '../context/TemaProvider';
import {
  GRUPOS_COLOR,
  ROLES_CATALOGO,
  ROLES_FUENTE,
  FAMILIAS_FUENTE,
  clonarTema,
  hexDeRol,
  idDesdeNombre,
  varDeRol,
  type ModoColor,
  type ModoPorDefecto,
  type RolFuente,
  type Tema,
} from '../models/tema';
import { aplicar, planificar } from '../utils/adoptarTema';
import {
  exportarTema,
  guardarTemas,
  importarTema,
  restaurarTemas,
} from '../services/temaApi';

type Pestana = ModoColor | 'fuentes';

export function GestorTemas() {
  const navigate = useNavigate();
  const { permisos } = useAppStore();
  const { doc, cargando, recargar, previsualizar } = useTema();

  const puedeEditar = !permisos || permisos.editar_diseño;

  // ── Borrador ──────────────────────────────────────────────────
  const [temas, setTemas] = useState<Tema[]>([]);
  const [activo, setActivo] = useState('');
  const [editando, setEditando] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [sucio, setSucio] = useState(false);
  const [pestana, setPestana] = useState<Pestana>('light');
  const [mensaje, setMensaje] = useState('');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [adoptando, setAdoptando] = useState(false);
  const archivoRef = useRef<HTMLInputElement>(null);

  // Se siembra del servidor una sola vez. Si se resembrara en cada cambio del
  // documento, el `tema.updated` provocado por tu propio guardado —o por el
  // de otro— borraría lo que estuvieras escribiendo a media frase.
  const sembrado = useRef(false);
  useEffect(() => {
    if (!doc || sembrado.current) return;
    sembrado.current = true;
    setTemas(doc.temas.map(clonarTema));
    setActivo(doc.activo);
    setEditando(doc.activo);
    setVersion(doc.version);
  }, [doc]);

  const tema = useMemo(
    () => temas.find((t) => t.id === editando) ?? null,
    [temas, editando]
  );

  // La vista previa: el borrador se aplica al documento de verdad.
  useEffect(() => {
    previsualizar(tema, pestana === 'fuentes' ? undefined : pestana);
  }, [tema, pestana, previsualizar]);

  // Salir del gestor devuelve los colores guardados, se haya guardado o no.
  useEffect(() => () => previsualizar(null), [previsualizar]);

  // Aviso del navegador si te vas con cambios sin guardar. No es infalible
  // (navegar dentro de la aplicación no lo dispara), pero cubre el caso que
  // de verdad pierde trabajo: cerrar la pestaña.
  useEffect(() => {
    if (!sucio) return;
    const alSalir = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', alSalir);
    return () => window.removeEventListener('beforeunload', alSalir);
  }, [sucio]);

  // ── Mutaciones del borrador ───────────────────────────────────
  const tocar = useCallback(
    (id: string, cambio: (t: Tema) => Tema) => {
      setTemas((prev) => prev.map((t) => (t.id === id ? cambio(clonarTema(t)) : t)));
      setSucio(true);
      setMensaje('');
    },
    []
  );

  const setColor = (rol: string, valor: string) => {
    if (!tema || pestana === 'fuentes') return;
    const m = pestana;
    tocar(tema.id, (t) => {
      t.colores[m] = { ...t.colores[m], [rol]: valor };
      return t;
    });
  };

  const setFuente = (rol: RolFuente, campo: string, valor: string | number) => {
    if (!tema) return;
    tocar(tema.id, (t) => {
      t.fuentes[rol] = { ...t.fuentes[rol], [campo]: valor } as any;
      return t;
    });
  };

  const nuevoTema = () => {
    const base = tema ?? temas[0];
    if (!base) return;
    const nombre = window.prompt('Nombre del tema nuevo:', 'Tema nuevo');
    if (!nombre?.trim()) return;
    const id = idDesdeNombre(nombre, temas.map((t) => t.id));
    const copia = clonarTema(base);
    copia.id = id;
    copia.nombre = nombre.trim();
    // Un tema creado por alguien SÍ se puede borrar, aunque salga de uno que no.
    copia.bloqueado = false;
    setTemas((p) => [...p, copia]);
    setEditando(id);
    setSucio(true);
  };

  const duplicar = () => {
    if (!tema) return;
    const nombre = `${tema.nombre} (copia)`;
    const id = idDesdeNombre(nombre, temas.map((t) => t.id));
    const copia = clonarTema(tema);
    copia.id = id;
    copia.nombre = nombre;
    copia.bloqueado = false;
    setTemas((p) => [...p, copia]);
    setEditando(id);
    setSucio(true);
  };

  const renombrar = () => {
    if (!tema) return;
    const nombre = window.prompt('Nombre del tema:', tema.nombre);
    if (!nombre?.trim()) return;
    // Se cambia el NOMBRE, no el id: el id es lo que guarda `activo` y lo que
    // referencia un tema exportado. Renombrar no puede romper esos enlaces.
    tocar(tema.id, (t) => {
      t.nombre = nombre.trim();
      return t;
    });
  };

  const borrar = () => {
    if (!tema || tema.bloqueado) return;
    if (temas.length <= 1) {
      setError('Tiene que quedar al menos un tema.');
      return;
    }
    if (!window.confirm(`¿Borrar el tema «${tema.nombre}»?`)) return;
    const resto = temas.filter((t) => t.id !== tema.id);
    setTemas(resto);
    // Si se borra el activo, manda el primero que quede: dejar `activo`
    // apuntando a un tema que ya no existe haría que el servidor lo rechazara
    // al guardar, y el mensaje no diría por qué.
    if (activo === tema.id) setActivo(resto[0].id);
    setEditando(resto[0].id);
    setSucio(true);
  };

  const anadirColor = () => {
    if (!tema) return;
    const nombre = window.prompt(
      'Nombre del color nuevo (por ejemplo «Marca de agua»):'
    );
    if (!nombre?.trim()) return;
    const base = nombre
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .split(/\s+/)
      .filter(Boolean);
    const id =
      base.length === 0
        ? ''
        : base[0] + base.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
    if (!id || !/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
      setError(`De «${nombre}» no sale un nombre válido. Usa letras y espacios.`);
      return;
    }
    if (ROLES_CATALOGO.includes(id) || tema.extras.some((e) => e.id === id)) {
      setError(`Ya existe un color llamado «${id}».`);
      return;
    }
    tocar(tema.id, (t) => {
      t.extras = [...t.extras, { id, nombre: nombre.trim() }];
      t.colores.light = { ...t.colores.light, [id]: '#888888' };
      t.colores.dark = { ...t.colores.dark, [id]: '#888888' };
      return t;
    });
    setError('');
  };

  const quitarColor = (rol: string) => {
    if (!tema) return;
    tocar(tema.id, (t) => {
      t.extras = t.extras.filter((e) => e.id !== rol);
      delete t.colores.light[rol];
      delete t.colores.dark[rol];
      return t;
    });
  };

  // ── Servidor ──────────────────────────────────────────────────
  const guardar = async (forzar = false) => {
    setGuardando(true);
    setError('');
    try {
      const d = await guardarTemas(temas, activo, forzar ? null : version, forzar);
      setVersion(d.version);
      setSucio(false);
      setMensaje('Temas guardados.');
      await recargar();
    } catch (e: any) {
      if (e?.status === 409) {
        const quiere = window.confirm(
          'Otro usuario guardó los temas mientras editabas.\n\n' +
            'Si continúas, tus cambios reemplazan los suyos.\n\n¿Continuar?'
        );
        if (quiere) {
          setGuardando(false);
          return guardar(true);
        }
        setError('No se guardó nada. Recarga la página para ver lo que hay ahora.');
      } else {
        setError(e?.message ?? 'No se pudo guardar.');
      }
    } finally {
      setGuardando(false);
    }
  };

  const restaurar = async () => {
    if (
      !window.confirm(
        'Volver a los temas de fábrica.\n\nLos temas que hayas creado se ' +
          'pierden. ¿Continuar?'
      )
    )
      return;
    try {
      const d = await restaurarTemas();
      sembrado.current = false;
      setSucio(false);
      setVersion(d.version);
      await recargar();
      setMensaje('Restaurados los temas de fábrica.');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo restaurar.');
    }
  };

  /**
   * Engancha al tema los widgets que ya estaban guardados.
   *
   * Se exige tener el tema guardado primero: el analisis compara contra la
   * paleta que hay EN EL SERVIDOR, y hacerlo sobre un borrador dejaria los
   * diseños apuntando a colores que quiza nunca se guarden.
   */
  const adoptar = async () => {
    if (sucio) {
      setError(
        'Guarda antes los cambios del tema. Los diseños se enganchan a la ' +
          'paleta guardada, no al borrador.'
      );
      return;
    }
    const base = temas.find((t) => t.id === activo);
    if (!base) return;
    setAdoptando(true);
    setError('');
    setMensaje('');
    try {
      const plan = await planificar(base);
      if (plan.cambios.length === 0) {
        setMensaje(
          'No hay nada que enganchar: ningun widget usa exactamente un color ' +
            'de este tema. (Solo se sustituyen coincidencias exactas.)'
        );
        return;
      }
      const muestra = plan.cambios
        .slice(0, 12)
        .map((c) => `  · ${c.pantalla} / ${c.widget} / ${c.donde}: ${c.de} -> ${c.a}`)
        .join('\n');
      const resto =
        plan.cambios.length > 12
          ? `\n  … y ${plan.cambios.length - 12} mas`
          : '';
      const aviso = plan.ilegibles.length
        ? `\n\nNO se tocaran (no se pudieron leer del servidor): ` +
          plan.ilegibles.join(', ')
        : '';
      const sigue = window.confirm(
        `Se cambiaran ${plan.cambios.length} colores en ` +
          `${plan.pendientes.length} pantalla(s):\n\n${muestra}${resto}` +
          `${aviso}\n\nA partir de entonces esos widgets seguiran al tema. ` +
          `¿Continuar?`
      );
      if (!sigue) return;
      const r = await aplicar(plan);
      if (r.fallidas.length) {
        setError(
          `Enganchadas ${r.hechas.length}. Sin tocar: ` +
            r.fallidas.map((f) => `${f.pantalla} (${f.motivo})`).join('; ')
        );
      } else {
        setMensaje(
          `Listo: ${plan.cambios.length} colores enganchados al tema en ` +
            `${r.hechas.length} pantalla(s).`
        );
      }
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo analizar los diseños.');
    } finally {
      setAdoptando(false);
    }
  };

  const importar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    e.target.value = '';
    if (!archivo) return;
    try {
      const traido = await importarTema(archivo);
      // El id puede chocar con uno de aquí. Se le da uno libre en vez de
      // reemplazar en silencio el que ya existe.
      const ocupados = temas.map((t) => t.id);
      const copia = clonarTema(traido);
      if (ocupados.includes(copia.id)) {
        copia.id = idDesdeNombre(copia.nombre || copia.id, ocupados);
        setMensaje(
          `Ya había un tema con ese id; el importado entró como «${copia.id}».`
        );
      }
      copia.bloqueado = false;
      setTemas((p) => [...p, copia]);
      setEditando(copia.id);
      setSucio(true);
      setError('');
    } catch (err: any) {
      setError(err?.message ?? 'No se pudo leer el archivo.');
    }
  };

  // ── Render ────────────────────────────────────────────────────
  if (cargando) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Cargando temas…
      </div>
    );
  }

  const modoColor: ModoColor = pestana === 'fuentes' ? 'light' : pestana;

  return (
    <div className="flex h-full flex-col bg-slate-50 dark:bg-navy">
      {/* ── Cabecera ───────────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-navy-slate dark:bg-navy-soft">
        <button
          type="button"
          onClick={() => navigate('/menu')}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-siemens dark:hover:bg-navy"
          title="Volver al menú"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2">
          <PaletteIcon className="h-5 w-5 text-siemens" />
          <div>
            <h1 className="text-sm font-bold text-navy dark:text-slate-100">
              Gestor de Temas
            </h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Colores y tipografías del proyecto
            </p>
          </div>
        </div>

        <div className="mx-2 h-8 w-px bg-slate-200 dark:bg-navy-slate" />

        {/* Qué tema se está EDITANDO. Es distinto del que está activo: se
            puede retocar uno sin publicarlo todavía. */}
        <label className="flex items-center gap-2 text-xs">
          <span className="text-slate-500 dark:text-slate-400">Tema</span>
          <select
            value={editando}
            onChange={(e) => setEditando(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-navy outline-none focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          >
            {temas.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nombre}
                {t.id === activo ? '  ·  en uso' : ''}
              </option>
            ))}
          </select>
        </label>

        {puedeEditar && (
          <div className="flex items-center gap-1">
            <Herramienta icono={PlusIcon} titulo="Tema nuevo" onClick={nuevoTema} />
            <Herramienta icono={CopyIcon} titulo="Duplicar" onClick={duplicar} />
            <Herramienta icono={PencilIcon} titulo="Renombrar" onClick={renombrar} />
            <Herramienta
              icono={Trash2Icon}
              titulo={
                tema?.bloqueado
                  ? 'Los temas de serie no se borran'
                  : 'Borrar este tema'
              }
              onClick={borrar}
              desactivado={!!tema?.bloqueado}
            />
            <div className="mx-1 h-6 w-px bg-slate-200 dark:bg-navy-slate" />
            <Herramienta
              icono={DownloadIcon}
              titulo="Exportar este tema a un archivo"
              onClick={() => tema && exportarTema(tema)}
            />
            <Herramienta
              icono={UploadIcon}
              titulo="Importar un tema desde un archivo"
              onClick={() => archivoRef.current?.click()}
            />
            <input
              ref={archivoRef}
              type="file"
              accept=".psitema,.json"
              className="hidden"
              onChange={importar}
            />
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* El modo con el que arranca quien abra el HMI y no haya elegido. */}
          <label className="flex items-center gap-2 text-xs">
            <span className="text-slate-500 dark:text-slate-400">Modo inicial</span>
            <select
              value={tema?.modo_por_defecto ?? 'auto'}
              disabled={!tema || !puedeEditar}
              onChange={(e) =>
                tema &&
                tocar(tema.id, (t) => {
                  t.modo_por_defecto = e.target.value as ModoPorDefecto;
                  return t;
                })
              }
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-navy outline-none focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100"
            >
              <option value="auto">Según el sistema</option>
              <option value="light">Claro</option>
              <option value="dark">Oscuro</option>
            </select>
          </label>

          {puedeEditar && (
            <>
              {/* Marcar el tema como el de la instalación. Esto SÍ lo ven
                  todos los paneles en cuanto se guarda. */}
              <button
                type="button"
                onClick={() => {
                  if (!tema) return;
                  setActivo(tema.id);
                  setSucio(true);
                }}
                disabled={!tema || activo === tema.id}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-siemens hover:text-siemens disabled:cursor-not-allowed disabled:opacity-40 dark:border-navy-slate dark:text-slate-300"
              >
                <CheckIcon className="h-3.5 w-3.5" />
                {activo === tema?.id ? 'En uso' : 'Usar este'}
              </button>

              {/* Los diseños que ya existen no siguen al tema hasta que
                  alguien lo pide: reescribir colores de una instalacion en
                  marcha no puede pasar como efecto secundario de guardar. */}
              <Herramienta
                icono={Link2Icon}
                titulo={
                  adoptando
                    ? 'Analizando los diseños…'
                    : 'Enganchar al tema los widgets que ya existen'
                }
                onClick={() => void adoptar()}
                desactivado={adoptando} />

              <Herramienta
                icono={RotateCcwIcon}
                titulo="Volver a los temas de fábrica"
                onClick={restaurar}
              />

              <button
                type="button"
                onClick={() => void guardar()}
                disabled={!sucio || guardando}
                className="flex items-center gap-1.5 rounded-lg bg-siemens px-4 py-1.5 text-xs font-bold text-white transition hover:bg-siemens-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SaveIcon className="h-3.5 w-3.5" />
                {guardando ? 'Guardando…' : sucio ? 'Guardar' : 'Guardado'}
              </button>
            </>
          )}
        </div>
      </header>

      {(error || mensaje) && (
        <div
          className={`flex items-center gap-2 px-4 py-2 text-xs ${
            error
              ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
              : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
          }`}
        >
          {error && <AlertTriangleIcon className="h-4 w-4 shrink-0" />}
          <span>{error || mensaje}</span>
        </div>
      )}

      {!puedeEditar && (
        <div className="bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Estás viendo los temas en modo consulta. Cambiarlos necesita el rol
          de Administradores, el mismo que el Diseñador.
        </div>
      )}

      {/* ── Pestañas ───────────────────────────────────────── */}
      <nav className="flex gap-1 border-b border-slate-200 bg-white px-4 dark:border-navy-slate dark:bg-navy-soft">
        <Pestanya
          activa={pestana === 'light'}
          onClick={() => setPestana('light')}
          icono={SunIcon}
          texto="Colores · modo claro"
        />
        <Pestanya
          activa={pestana === 'dark'}
          onClick={() => setPestana('dark')}
          icono={MoonIcon}
          texto="Colores · modo oscuro"
        />
        <Pestanya
          activa={pestana === 'fuentes'}
          onClick={() => setPestana('fuentes')}
          icono={TypeIcon}
          texto="Tipografías"
        />
      </nav>

      {/* ── Cuerpo ─────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto mp-scroll">
        {!tema ? (
          <p className="p-8 text-center text-sm text-slate-400">
            No hay ningún tema seleccionado.
          </p>
        ) : pestana === 'fuentes' ? (
          <PanelFuentes tema={tema} onCambio={setFuente} editable={puedeEditar} />
        ) : (
          <PanelColores
            tema={tema}
            modo={modoColor}
            editable={puedeEditar}
            onCambio={setColor}
            onAnadir={anadirColor}
            onQuitar={quitarColor}
          />
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Piezas
// =========================================================================

function Herramienta({
  icono: Icono,
  titulo,
  onClick,
  desactivado,
}: {
  icono: React.ComponentType<{ className?: string }>;
  titulo: string;
  onClick: () => void;
  desactivado?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={desactivado}
      title={titulo}
      aria-label={titulo}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-siemens disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-navy"
    >
      <Icono className="h-4 w-4" />
    </button>
  );
}

function Pestanya({
  activa,
  onClick,
  icono: Icono,
  texto,
}: {
  activa: boolean;
  onClick: () => void;
  icono: React.ComponentType<{ className?: string }>;
  texto: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition ${
        activa
          ? 'border-siemens text-siemens'
          : 'border-transparent text-slate-500 hover:text-navy dark:text-slate-400 dark:hover:text-slate-200'
      }`}
    >
      <Icono className="h-4 w-4" />
      {texto}
    </button>
  );
}

/** Una fila de color: etiqueta, nombre de la variable, muestra y valor. */
function FilaColor({
  tema,
  modo,
  rol,
  etiqueta,
  ayuda,
  editable,
  onCambio,
  onQuitar,
}: {
  tema: Tema;
  modo: ModoColor;
  rol: string;
  etiqueta: string;
  ayuda?: string;
  editable: boolean;
  onCambio: (rol: string, valor: string) => void;
  onQuitar?: (rol: string) => void;
}) {
  const valor = tema.colores[modo]?.[rol] ?? '';
  const hex = hexDeRol(tema, modo, rol);

  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-slate-50 dark:hover:bg-navy/60">
      {/* La muestra. Sobre un damero para que un color con transparencia se
          distinga de uno opaco, que es justo lo que un cuadrado liso oculta. */}
      <span
        className="h-7 w-7 shrink-0 rounded border border-slate-300 dark:border-navy-slate"
        style={{
          backgroundImage:
            'linear-gradient(45deg,#cbd5e1 25%,transparent 25%,transparent 75%,#cbd5e1 75%),' +
            'linear-gradient(45deg,#cbd5e1 25%,transparent 25%,transparent 75%,#cbd5e1 75%)',
          backgroundSize: '8px 8px',
          backgroundPosition: '0 0, 4px 4px',
        }}
      >
        <span
          className="block h-full w-full rounded-[3px]"
          style={{ background: valor || 'transparent' }}
        />
      </span>

      <div className="min-w-0 flex-1" title={ayuda}>
        <div className="truncate text-xs font-medium text-navy dark:text-slate-200">
          {etiqueta}
        </div>
        {/* El nombre técnico se enseña porque es lo que hay que escribir en un
            widget para engancharlo al tema. Sin esto, el gestor sería bonito e
            inútil: no habría forma de saber cómo se llama lo que acabas de
            cambiar. */}
        <code className="text-[10px] text-slate-400">{varDeRol(rol)}</code>
      </div>

      {/* `<input type="color">` solo sabe de #rrggbb. Cuando el valor es otra
          cosa (rgba, transparent…) no se dibuja el selector: enseñar uno
          cargado con un color inventado es lo que hacía que abrirlo y cerrarlo
          guardara ese color de mentira. */}
      {hex !== null ? (
        <input
          type="color"
          value={hex}
          disabled={!editable}
          onChange={(e) => onCambio(rol, e.target.value)}
          className="h-7 w-9 shrink-0 cursor-pointer rounded border border-slate-200 bg-white p-0.5 disabled:cursor-not-allowed dark:border-navy-slate dark:bg-navy"
        />
      ) : (
        <span className="shrink-0 text-[10px] text-slate-400">sin selector</span>
      )}

      <input
        type="text"
        value={valor}
        disabled={!editable}
        spellCheck={false}
        onChange={(e) => onCambio(rol, e.target.value)}
        className="w-32 shrink-0 rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[11px] text-navy outline-none focus:border-siemens disabled:cursor-not-allowed disabled:opacity-60 dark:border-navy-slate dark:bg-navy dark:text-slate-200"
      />

      {onQuitar && editable && (
        <button
          type="button"
          onClick={() => onQuitar(rol)}
          title="Quitar este color"
          className="shrink-0 rounded p-1 text-slate-400 transition hover:text-red-500"
        >
          <Trash2Icon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function PanelColores({
  tema,
  modo,
  editable,
  onCambio,
  onAnadir,
  onQuitar,
}: {
  tema: Tema;
  modo: ModoColor;
  editable: boolean;
  onCambio: (rol: string, valor: string) => void;
  onAnadir: () => void;
  onQuitar: (rol: string) => void;
}) {
  // Colores que el tema trae y el catálogo no conoce: los de «Añadir color»,
  // y los que venga a saber de un tema importado de otra versión. Se enseñan
  // igual; esconderlos sería la forma más rápida de que alguien pierda uno.
  const extras = useMemo(() => {
    const conocidos = new Set(ROLES_CATALOGO);
    const etiquetas = new Map(tema.extras.map((e) => [e.id, e.nombre]));
    return Object.keys({ ...tema.colores.light, ...tema.colores.dark })
      .filter((r) => !conocidos.has(r))
      .sort()
      .map((r) => ({ id: r, label: etiquetas.get(r) ?? r }));
  }, [tema]);

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        {GRUPOS_COLOR.map((g) => (
          <section
            key={g.id}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-card dark:border-navy-slate dark:bg-navy-soft"
          >
            <h2 className="text-sm font-bold text-navy dark:text-slate-100">
              {g.label}
            </h2>
            <p className="mb-2 mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {g.descripcion}
            </p>
            <div className="grid gap-0.5 xl:grid-cols-2">
              {g.roles.map((r) => (
                <FilaColor
                  key={r.id}
                  tema={tema}
                  modo={modo}
                  rol={r.id}
                  etiqueta={r.label}
                  ayuda={r.ayuda}
                  editable={editable}
                  onCambio={onCambio}
                />
              ))}
            </div>
          </section>
        ))}

        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-4 dark:border-navy-slate dark:bg-navy-soft">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-navy dark:text-slate-100">
                Colores propios
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Para lo que la paleta estándar no cubre. Se usan igual:{' '}
                <code>var(--psi-loquesea)</code>.
              </p>
            </div>
            {editable && (
              <button
                type="button"
                onClick={onAnadir}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-300"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Añadir color
              </button>
            )}
          </div>
          {extras.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-slate-400">
              Todavía no hay ninguno.
            </p>
          ) : (
            <div className="grid gap-0.5 xl:grid-cols-2">
              {extras.map((e) => (
                <FilaColor
                  key={e.id}
                  tema={tema}
                  modo={modo}
                  rol={e.id}
                  etiqueta={e.label}
                  editable={editable}
                  onCambio={onCambio}
                  onQuitar={onQuitar}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <Vista modo={modo} />
    </div>
  );
}

/**
 * La vista previa.
 *
 * Está pintada con las variables del tema y NADA más, así que enseña lo que
 * el tema hace de verdad. Y va pegada arriba: cambiar un color y tener que
 * bajar a buscar el efecto es lo que hace que nadie mire la previa.
 */
function Vista({ modo }: { modo: ModoColor }) {
  const caja = (bg: string, fg: string, texto: string) => (
    <div
      className="rounded-lg px-3 py-2 text-xs font-semibold"
      style={{ background: `var(${bg})`, color: `var(${fg})` }}
    >
      {texto}
    </div>
  );

  return (
    <aside className="h-fit lg:sticky lg:top-4">
      <div
        className="rounded-xl border p-4"
        style={{
          background: 'var(--psi-background)',
          borderColor: 'var(--psi-outline-variant)',
          color: 'var(--psi-on-background)',
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3
            className="text-sm font-bold"
            style={{ fontFamily: 'var(--psi-fuente-titulo)' }}
          >
            Vista previa
          </h3>
          <span className="text-[10px] opacity-60">
            {modo === 'dark' ? 'oscuro' : 'claro'}
          </span>
        </div>

        <div
          className="mb-3 rounded-lg border p-3"
          style={{
            background: 'var(--psi-surface)',
            borderColor: 'var(--psi-outline-variant)',
            color: 'var(--psi-on-surface)',
          }}
        >
          <div className="text-[10px] uppercase tracking-wide opacity-70">
            Caudal de entrada
          </div>
          <div
            style={{
              fontFamily: 'var(--psi-fuente-dato)',
              fontSize: 'var(--psi-fuente-dato-tamano)',
              fontWeight: 'var(--psi-fuente-dato-peso)' as any,
              color: 'var(--psi-primary)',
            }}
          >
            128,4 m³/h
          </div>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2">
          {caja('--psi-primary', '--psi-on-primary', 'Arrancar')}
          {caja('--psi-secondary', '--psi-on-secondary', 'Ajustes')}
          {caja('--psi-primary-container', '--psi-on-primary-container', 'Contenedor')}
          {caja('--psi-tertiary', '--psi-on-tertiary', 'Terciario')}
        </div>

        <div className="space-y-1.5">
          {caja('--psi-error-container', '--psi-on-error-container', 'Nivel alto — bomba 2')}
          {caja('--psi-warning-container', '--psi-on-warning-container', 'Presión cerca del límite')}
          {caja('--psi-success-container', '--psi-on-success-container', 'Todo normal')}
        </div>

        <p
          className="mt-3 text-[11px] leading-relaxed"
          style={{
            color: 'var(--psi-on-surface-variant)',
            fontFamily: 'var(--psi-fuente-cuerpo)',
          }}
        >
          Texto corrido con la tipografía del tema. Sirve para comprobar que se
          lee sobre este fondo antes de ponerlo en un panel de planta.
        </p>
      </div>
    </aside>
  );
}

function PanelFuentes({
  tema,
  onCambio,
  editable,
}: {
  tema: Tema;
  onCambio: (rol: RolFuente, campo: string, valor: string | number) => void;
  editable: boolean;
}) {
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-3">
        {ROLES_FUENTE.map((r) => {
          const f = tema.fuentes[r.id];
          if (!f) return null;
          const conocida = FAMILIAS_FUENTE.some((x) => x.valor === f.familia);
          return (
            <section
              key={r.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-card dark:border-navy-slate dark:bg-navy-soft"
            >
              <h2 className="text-sm font-bold text-navy dark:text-slate-100">
                {r.label}
              </h2>
              <p className="mb-3 mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                {r.ayuda}
              </p>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    Familia
                  </span>
                  <select
                    value={conocida ? f.familia : '__otra'}
                    disabled={!editable}
                    onChange={(e) =>
                      onCambio(
                        r.id,
                        'familia',
                        e.target.value === '__otra' ? f.familia : e.target.value
                      )
                    }
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-navy outline-none focus:border-siemens disabled:opacity-60 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
                  >
                    {FAMILIAS_FUENTE.map((x) => (
                      <option key={x.valor} value={x.valor}>
                        {x.label}
                      </option>
                    ))}
                    <option value="__otra">Personalizada…</option>
                  </select>
                  {!conocida && (
                    <input
                      type="text"
                      value={f.familia}
                      disabled={!editable}
                      spellCheck={false}
                      onChange={(e) => onCambio(r.id, 'familia', e.target.value)}
                      placeholder="'Mi Fuente', Arial, sans-serif"
                      className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono text-[11px] text-navy outline-none focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-200"
                    />
                  )}
                </label>

                <Num
                  label="Tamaño (px)"
                  value={f.tamano}
                  min={8}
                  max={96}
                  step={1}
                  editable={editable}
                  onChange={(v) => onCambio(r.id, 'tamano', v)}
                />
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    Grosor
                  </span>
                  <select
                    value={f.peso}
                    disabled={!editable}
                    onChange={(e) => onCambio(r.id, 'peso', Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-navy outline-none focus:border-siemens disabled:opacity-60 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
                  >
                    {[300, 400, 500, 600, 700, 800].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <Num
                  label="Interlineado"
                  value={f.interlineado}
                  min={0.8}
                  max={3}
                  step={0.05}
                  editable={editable}
                  onChange={(v) => onCambio(r.id, 'interlineado', v)}
                />
              </div>

              {/* La muestra usa la familia y el grosor que se acaban de
                  elegir, no los del tema aplicado: así se ve el cambio aunque
                  la previa esté en la otra pestaña. */}
              <p
                className="mt-3 truncate rounded-lg bg-slate-50 px-3 py-2 dark:bg-navy"
                style={{
                  fontFamily: f.familia,
                  fontSize: Math.min(f.tamano, 28),
                  fontWeight: f.peso,
                  lineHeight: f.interlineado,
                }}
              >
                Bomba P-101 · 128,4 m³/h · 1234567890
              </p>
            </section>
          );
        })}
      </div>

      <Vista modo="light" />
    </div>
  );
}

function Num({
  label,
  value,
  min,
  max,
  step,
  editable,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  editable: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={!editable}
        onChange={(e) => {
          const n = Number(e.target.value);
          // Un campo numérico vacío da NaN, y NaN guardado es un tema que el
          // servidor rechaza con un mensaje que no dice qué campo fue.
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-navy outline-none focus:border-siemens disabled:opacity-60 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
      />
    </label>
  );
}
