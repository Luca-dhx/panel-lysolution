import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, provesSessionInvalid, tokenStore } from '@/lib/api';
import type { PanelUser } from '@/types';

interface AuthContextValue {
  user: PanelUser | null;
  loading: boolean;
  /**
   * LE SERVEUR N'A PAS PU RÉPONDRE — la session n'est PAS invalidée pour autant.
   *
   * C'est l'état qui manquait. Sans lui, « je n'ai pas pu demander » et « tu
   * n'es plus connecté » étaient représentés par la même valeur (`user: null`),
   * et l'écran n'avait aucun moyen de les distinguer : il renvoyait au login
   * dans les deux cas.
   */
  unreachable: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /**
   * RELIT L'IDENTITÉ COURANTE (L12.C).
   *
   * La barre latérale affiche le nom du compte. Sans ce rafraîchissement, on
   * pourrait enregistrer son nom depuis « Mon profil » et continuer de lire
   * l'ancien à l'écran — l'utilisateur en conclurait que rien n'a été pris en
   * compte, et recommencerait.
   */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PanelUser | null>(null);
  const [loading, setLoading] = useState<boolean>(() => tokenStore.get() !== null);
  const [unreachable, setUnreachable] = useState(false);

  /**
   * ══ LA RELECTURE D'IDENTITÉ — ET LE DÉFAUT QU'ELLE PORTAIT ════════════════
   *
   * ── CE QUI ARRIVAIT, EXACTEMENT ───────────────────────────────────────────
   *
   * Ce chargement faisait `.catch(() => setUser(null))`. N'IMPORTE QUEL échec
   * de `/api/auth/me` vidait donc l'identité : un 500, un 503, un 502 d'nginx
   * pendant que le backend redémarrait, un `fetch` qui rejette. `RequireAuth`
   * lisait `user === null` et redirigeait vers `/login`.
   *
   * C'est la cause DIRECTE du symptôme observé : un déploiement échoue, on
   * recharge la page, le backend n'a pas fini de redémarrer, et l'utilisateur
   * se retrouve à l'écran de connexion. Son jeton n'avait pourtant jamais été
   * effacé — d'où le fait qu'un second rechargement, une fois le backend prêt,
   * le ramenait dans l'application sans qu'il ait à ressaisir quoi que ce soit.
   * Le symptôme n'était pas une déconnexion : c'était un écran de connexion
   * affiché à tort.
   *
   * ── LA RÈGLE, DÉSORMAIS ───────────────────────────────────────────────────
   *
   * Seule une erreur qui PROUVE l'invalidité de la session vide l'identité.
   * Tout le reste laisse la session intacte et lève `unreachable` : l'écran
   * affiche alors une reconnexion en cours, et réessaie.
   */
  const charger = useCallback(async () => {
    if (tokenStore.get() === null) {
      setUser(null);
      setUnreachable(false);
      setLoading(false);
      return;
    }
    try {
      const data = await api.me();
      setUser(data.user);
      setUnreachable(false);
    } catch (err) {
      if (provesSessionInvalid(err)) {
        // `request()` a déjà effacé le jeton après confirmation auprès de
        // l'autorité. Il n'y a rien à décider ici : on constate.
        setUser(null);
        setUnreachable(false);
      } else {
        // Le jeton reste. L'identité déjà connue reste. Seul l'accès manque.
        setUnreachable(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void charger();
  }, [charger]);

  /**
   * RECONNEXION AUTOMATIQUE — rapide d'abord, puis de plus en plus espacée.
   *
   * ── LA CONDITION D'ARRÊT EST LE SUCCÈS, PAS UN COMPTEUR ───────────────────
   *
   * L'effet ne vit que pendant `unreachable` : dès qu'une relecture aboutit,
   * l'état retombe et le minuteur est démonté. Il n'existe donc aucune boucle
   * qui survivrait au rétablissement — et c'est ce qui permet à l'application
   * de revenir SANS que l'utilisateur ait à recharger la page.
   *
   * ── POURQUOI L'ESPACEMENT CROÎT ───────────────────────────────────────────
   *
   * Un redémarrage dure quelques secondes : on veut être là tout de suite, d'où
   * le premier essai à une seconde. Une panne longue, elle, ne se répare pas en
   * étant interrogée — insister toutes les secondes pendant une heure ne ferait
   * qu'ajouter de la charge à un service déjà en difficulté, exactement quand
   * il a besoin de calme pour redémarrer.
   *
   * Le palier se stabilise à trente secondes : la reconnexion reste vivante
   * indéfiniment, mais son coût cesse de croître. C'est une VEILLE, pas une
   * boucle de sondage.
   */
  const PALIERS_RECONNEXION_MS = [1000, 2000, 5000, 10_000, 30_000];
  const [essaisReconnexion, setEssaisReconnexion] = useState(0);

  useEffect(() => {
    if (!unreachable) {
      setEssaisReconnexion(0);
      return undefined;
    }
    const delai = PALIERS_RECONNEXION_MS[
      Math.min(essaisReconnexion, PALIERS_RECONNEXION_MS.length - 1)
    ];
    const minuteur = setTimeout(() => {
      setEssaisReconnexion((n) => n + 1);
      void charger();
    }, delai);
    return () => clearTimeout(minuteur);
  }, [unreachable, essaisReconnexion, charger]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api.login(email, password);
    tokenStore.set(data.token);
    setUser(data.user);
    setUnreachable(false);
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setUnreachable(false);
  }, []);

  /**
   * Une relecture ÉCHOUÉE ne déconnecte pas : elle laisse l'identité en place.
   * « Je n'ai pas pu redemander » n'est pas « tu n'es plus connecté », et la
   * garde d'authentification tranchera de toute façon à la requête suivante.
   */
  const refresh = useCallback(async () => {
    await charger();
  }, [charger]);

  const value = useMemo(
    () => ({ user, loading, unreachable, login, logout, refresh }),
    [user, loading, unreachable, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth doit être utilisé à l’intérieur de <AuthProvider>.');
  }
  return ctx;
}
