// CSS module side-effect imports — Vite handles these at runtime, but tsc
// needs an ambient declaration to allow `import './foo.css'`.
declare module "*.css";
