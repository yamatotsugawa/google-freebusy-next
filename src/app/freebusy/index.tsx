import dynamic from 'next/dynamic';
const FreeBusyFinder = dynamic(() => import('../../components/FreeBusyFinder'), { ssr: false });

export default function Page() {
  return <FreeBusyFinder />;
}
