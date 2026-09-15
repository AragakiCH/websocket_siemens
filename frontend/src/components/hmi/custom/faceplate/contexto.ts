// =========================================================================
// custom/faceplate/contexto.ts
// Los tags de la instancia que envuelve al widget que se está dibujando.
//
// PARA QUÉ
// Dentro de un TIPO de faceplate, un widget no apunta a un tag sino a un
// parámetro: guarda `param:marcha`. Al dibujar, `PantallaEmbebida` traduce
// eso con el mapa de la instancia, y el widget ni se entera.
//
// Pero hay una cosa que el widget sí necesita saber por su cuenta: si tiene
// una ACCIÓN que abre otro faceplate y quiere pasarle sus mismos tags. El
// caso típico es el botón «Histórico» dentro del faceplate de un motor: abre
// el faceplate de histórico DEL MISMO motor. Sin esto habría que volver a
// elegir el tag a mano en cada una de las cuarenta instancias, que es
// exactamente lo que un faceplate existe para no hacer.
//
// Es el equivalente al paso del prefijo de TIA Portal, pero por parámetros
// con nombre en vez de por concatenación de cadenas.
//
// VACÍO ES LO NORMAL
// Un widget en una pantalla corriente no está dentro de ninguna instancia, y
// entonces esto es `undefined`: un `param:` en su acción no resuelve a nada y
// se queda sin asignar, que es la verdad.
// =========================================================================
import { createContext } from 'react';

export const ContextoMapaTags = createContext<Record<string, string> | undefined>(
  undefined
);
