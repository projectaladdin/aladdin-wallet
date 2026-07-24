import { createRoot } from 'react-dom/client';
import { App } from './popup';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found in popup.html');
createRoot(root).render(<App />);
