import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Expone el servidor en la red local → celular/tablet pueden acceder
    host: '0.0.0.0',
    port: 3001, // distinto al del proyecto hermano (3000) para poder correr ambos a la vez

    // Servidor local en HTTP plano a propósito: el contexto seguro que exige
    // getUserMedia lo aporta ngrok (su URL pública es https), no hace falta
    // (ni conviene) un certificado self-signed local — ngrok no puede
    // tunelear http hacia un origen que espera TLS.
    // Para probar por IP de LAN sin ngrok, un https local sí sería necesario
    // de nuevo (@vitejs/plugin-basic-ssl), pero no es el flujo actual.

    // Dominios de ngrok permitidos, para probar en el celular sin desplegar
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.dev', '.ngrok.io'],
  },
  // Permite que Vite procese las variables VITE_* del .env
  envPrefix: 'VITE_',
});
