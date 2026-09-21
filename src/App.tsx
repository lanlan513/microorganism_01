import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { ParticleBackground } from './components/ParticleBackground';
import { HomePage } from './pages/HomePage';
import { CategoryPage } from './pages/CategoryPage';
import { DetailPage } from './pages/DetailPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PetriDishPage } from './petri/PetriDishPage';
import { PetriStressPage } from './petri/PetriStressPage';
import { useAppStore } from './store/useAppStore';
import type { Microbe } from '../shared/types';

export default function App() {
  const fetchMicrobes = useAppStore((s) => s.fetchMicrobes);
  const [specimens, setSpecimens] = useState<Microbe[]>([]);

  useEffect(() => {
    fetchMicrobes({ limit: 100 }).then(() => {
      // 直接从 store 取最新列表
      setSpecimens(useAppStore.getState().microbes);
    });
  }, [fetchMicrobes]);

  return (
    <Router>
      <div className="relative min-h-screen flex flex-col">
        <ParticleBackground />
        <Navbar />
        <main className="relative z-10 flex-1">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/category/:category" element={<CategoryPage />} />
            <Route path="/microbe/:id" element={<DetailPage />} />
            <Route path="/petri" element={<PetriDishPage specimens={specimens} />} />
            <Route path="/petri/stress" element={<PetriStressPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </Router>
  );
}
