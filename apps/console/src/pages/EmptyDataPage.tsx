type Props = { title: string; hint: string };

export function EmptyDataPage({ title, hint }: Props) {
  return (
    <main>
      <h1>{title}</h1>
      <div data-testid="empty-state">
        <p>{hint}</p>
      </div>
    </main>
  );
}
