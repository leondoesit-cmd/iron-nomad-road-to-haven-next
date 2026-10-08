import './ui/styles.css';
import { Game } from './game/game';
import { initSave } from './save/save';
import { perf } from './core/perfMarks';

// Every module above is fetched and evaluated by now.
perf.mark('boot:main');
const game = new Game();
perf.mark('boot:game');
declare global {
  interface Window {
    __game?: Game;
  }
}
window.__game = game;
// The title does not wait for the save: Continue lights up when it has been read (`Overlays.showTitle`).
void initSave();
void game.start();
