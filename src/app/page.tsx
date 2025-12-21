export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <h1 className="text-4xl font-bold mb-4">
        Get clarity - without being told what to do.
      </h1>

      <p className="text-lg max-w-xl mb-6">
        Ask a question. Choose a lens. Get a grounded perspective you can use or ignore.
      </p>

      <a
        href="/ask"
        className="bg-black text-white px-6 py-3 rounded-md text-lg"
      >
        Ask a Question - $1.99
      </a>

      <p className="text-sm text-gray-500 mt-4">
        Not fortune telling. No predictions. Just perspective.
      </p>
    </main>
  );
}