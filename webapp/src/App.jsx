import './App.css';
import LandingPage from './LandingPage';
import WebApp from './WebApp';

function App() {
  const isTelegram = typeof window !== 'undefined' && window.Telegram?.WebApp?.initData;

  return (
    <div className="App">
      {isTelegram ? <WebApp /> : <LandingPage />}
    </div>
  );
}

export default App;
