import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './lib/prefs';
import { Overlays } from './ui';
import './styles.css';

initTheme();
createRoot(document.getElementById('root')!).render(<><App /><Overlays /></>);
