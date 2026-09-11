// =========================================================================
// TemaProvider.tsx
// Carga los temas del servidor y los aplica al documento.
//
// QUÉ HACE, EXACTAMENTE
// Una sola cosa: escribir las variables CSS de `--psi-*` en `<html>`. Nada
// más. Quien las usa es el CSS de la aplicación y los propios widgets, que
// guardan `var(--psi-primary)` en vez de un color literal.
//
// POR QUÉ ESTÁ POR ENCIMA DE LAS RUTAS
// Porque el tema tiene que estar puesto ANTES de que se pinte la primera
// pantalla, y tiene que seguir puesto al navegar. Montarlo dentro de una
// página haría que el Diseñador y la Vista Previa cargaran el tema por
// separado, y que se vieran distintos durante el primer fotograma.
//
// PREVISUALIZACIÓN
// El Gestor de Temas necesita enseñar los cambios ANTES de guardarlos. Para
// eso está `previsualizar()`: aplica un tema que todavía no existe en el
// servidor. Se deshace solo al desmontarse el gestor, así que salir sin
// guardar no deja los colores a medias.
// =========================================================================
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAppStore } from './AppStore';
import type { ThemeMode } from '../models/plc';
import { leerTemas } from '../services/temaApi';
import {
  aplicarTema,
  type DocumentoTemas,
  type ModoColor,
  type Tema,
} from '../models/tema';

/**
 * Dónde se recuerda que ESTE navegador ya eligió modo.
 *
 * Hace falta para poder distinguir «el operario prefiere claro» de «nadie ha
 * dicho nada todavía». Sin esa distinción, el `modo_por_defecto` del tema no
 * se podría respetar nunca (siempre habría un valor previo que lo pisara) o
 * pisaría siempre la elección del operario. El modo es lo ÚNICO que se guarda
 * por navegador: los temas en sí son del servidor, para que dos paneles de la
 * misma línea no acaben con paletas distintas.
 */
const CLAVE_MODO = 'hmi.modo-color';

interface CtxTema {
  doc: DocumentoTemas | null;
  temas: Tema[];
  /** El tema activo, ya resuelto. */
  tema: Tema | null;
  /** Claro u oscuro, con 'auto' ya resuelto contra el sistema operativo. */
  modo: ModoColor;
  cargando: boolean;
  error: string;
  /** Vuelve a pedir los temas al servidor (tras guardar en el gestor). */
  recargar: () => Promise<void>;
  /** Pinta un tema que aún no está guardado. `null` vuelve al activo. */
  previsualizar: (tema: Tema | null, modo?: ModoColor) => void;
}

const Ctx = createContext<CtxTema | null>(null);

export function TemaProvider({ children }: { children: React.ReactNode }) {
  const { config, isDark, setTheme } = useAppStore();
  const [doc, setDoc] = useState<DocumentoTemas | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [vista, setVista] = useState<{ tema: Tema; modo?: ModoColor } | null>(
    null
  );

  // Los nombres de variable escritos en la última aplicación, para poder
  // retirar las que el tema siguiente no defina.
  const escritas = useRef<string[]>([]);
  // El modo por defecto solo se aplica UNA vez por carga de página: si se
  // reaplicara en cada recarga de temas, cambiar el modo a mano y guardar
  // cualquier cosa en el gestor te lo devolvería al del tema.
  //
  // Guarda QUÉ se sembró, no solo que se sembró: es lo que permite distinguir
  // «esto lo puso el Modo inicial del tema» de «esto lo eligió una persona».
  const sembrado = useRef<string | null>(null);
  const haElegido = useRef(false);

  const cargar = useCallback(async () => {
    try {
      const d = await leerTemas();
      setDoc(d);
      setError('');
    } catch (e: any) {
      // Un fallo aquí NO puede dejar la aplicación en blanco: sin variables
      // CSS, el CSS usa sus valores de respaldo y todo se ve como antes de
      // que existieran los temas. Se avisa y se sigue.
      setError(e?.message ?? 'No se pudieron cargar los temas.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Otro administrador guardó los temas: se aplican aquí al momento. Es lo
  // que hace que cambiar el color corporativo se vea en los paneles de planta
  // sin ir máquina por máquina.
  useEffect(() => {
    const alMensaje = (ev: Event) => {
      const msg = (ev as CustomEvent).detail;
      if (msg?.type !== 'tema.updated') return;
      // El documento viaja dentro del propio evento, así que no hace falta
      // que veinte paneles disparen un GET a la vez al recibirlo.
      if (msg.documento) setDoc(msg.documento as DocumentoTemas);
      else void cargar();
    };
    window.addEventListener('hmi:ws', alMensaje as EventListener);
    return () => window.removeEventListener('hmi:ws', alMensaje as EventListener);
  }, [cargar]);

  const temas = doc?.temas ?? [];
  const activo = useMemo(
    () => temas.find((t) => t.id === doc?.activo) ?? temas[0] ?? null,
    [temas, doc?.activo]
  );
  const tema = vista?.tema ?? activo;

  // El modo por defecto del tema, la primera vez y solo si este navegador no
  // ha elegido ya.
  useEffect(() => {
    if (!activo || sembrado.current !== null) return;
    let elegido: string | null = null;
    try {
      elegido = window.localStorage.getItem(CLAVE_MODO);
    } catch {
      // Modo privado o almacenamiento bloqueado: se sigue con el del tema.
    }
    // Lo que este navegador eligió manda sobre el «Modo inicial» del tema.
    const modoInicial = elegido ?? activo.modo_por_defecto ?? 'auto';
    if (elegido) haElegido.current = true;
    sembrado.current = modoInicial;
    setTheme(modoInicial as ThemeMode);
  }, [activo, setTheme]);

  /* Recordar la elección de quien está delante.
   *
   * Se guarda `config.theme` —'light', 'dark' o 'auto'— y NO `isDark`. Quien
   * elige «Automático» está pidiendo seguir al sistema operativo; guardarlo
   * resuelto a claro u oscuro lo dejaría clavado en el valor que tuviera esa
   * tarde y dejaría de seguir a nadie.
   *
   * Y no se guarda lo que se sembró: eso no lo eligió nadie, es el «Modo
   * inicial» que puso el administrador. Si se congelara aquí, cambiarlo más
   * adelante en el Gestor de Temas no llegaría a ninguna máquina que ya
   * hubiera abierto la aplicación una vez. */
  useEffect(() => {
    if (sembrado.current === null) return;
    if (!haElegido.current && config.theme === sembrado.current) return;
    haElegido.current = true;
    try {
      window.localStorage.setItem(CLAVE_MODO, config.theme);
    } catch {
      /* no se puede recordar; el tema decidirá en la próxima carga */
    }
  }, [config.theme]);

  const modo: ModoColor = vista?.modo ?? (isDark ? 'dark' : 'light');

  // El único efecto que toca el documento.
  useEffect(() => {
    escritas.current = aplicarTema(tema, modo, escritas.current);
  }, [tema, modo]);

  const previsualizar = useCallback(
    (t: Tema | null, m?: ModoColor) => setVista(t ? { tema: t, modo: m } : null),
    []
  );

  const valor = useMemo<CtxTema>(
    () => ({ doc, temas, tema, modo, cargando, error, recargar: cargar, previsualizar }),
    [doc, temas, tema, modo, cargando, error, cargar, previsualizar]
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useTema(): CtxTema {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTema debe usarse dentro de TemaProvider');
  return ctx;
}
