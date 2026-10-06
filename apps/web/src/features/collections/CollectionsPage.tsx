import { Button } from '../../components/ui/Button';
import { ErrorState, Skeleton } from '../../components/ui/Feedback';
import { CollectionTile, type SurfaceTone } from '../../components/ui/Merch';
import { Breadcrumbs } from '../../components/ui/Nav';
import { useCollections } from '../../lib/catalog';
import styles from './CollectionsPage.module.css';

const TONES: SurfaceTone[] = ['mist', 'sage', 'sand', 'mauve'];

export function CollectionsPage() {
  const collections = useCollections();
  return (
    <main className={`container ${styles.page}`}>
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Collections' }]} />
      <header className={styles.head}>
        <h1>Collections</h1>
        <p className="meta">Curated edits from the AVERO studio.</p>
      </header>
      {collections.isError ? (
        <ErrorState error={collections.error} action={<Button onClick={() => collections.refetch()}>Try again</Button>} />
      ) : (
        <div className={styles.grid}>
          {collections.data
            ? collections.data.map((c, i) => (
                <CollectionTile key={c.slug} to={`/collections/${c.slug}`} title={c.name} tone={TONES[i % TONES.length]!} image={c.coverImage} arch={i === 2} cta={`${c.productCount} ${c.productCount === 1 ? 'style' : 'styles'}`} />
              ))
            : [0, 1, 2, 3].map((i) => <Skeleton key={i} ratio="4/5" radius="lg" />)}
        </div>
      )}
    </main>
  );
}
