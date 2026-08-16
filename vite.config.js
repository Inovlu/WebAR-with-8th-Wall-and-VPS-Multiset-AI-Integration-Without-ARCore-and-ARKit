import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Expose the server on the local network → phone/tablet can access
    host: '0.0.0.0',
    port: 3001, // different from the sibling project (3000) to run both at once

    // Local server in plain HTTP on purpose: the secure context required
    // by getUserMedia is provided by ngrok (its public URL is https), no
    // need for (nor is it advisable to use) a self-signed local cert —
    // ngrok can't tunnel http to an origin that expects TLS.
    // To test via LAN IP without ngrok, a local https WOULD be needed
    // again (@vitejs/plugin-basic-ssl), but that's not the current flow.

    // Allowed ngrok domains, for testing on the phone without deploying
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.dev', '.ngrok.io'],
  },
  // Allow Vite to process VITE_* variables from .env
  envPrefix: 'VITE_',
});
