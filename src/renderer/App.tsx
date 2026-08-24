import { TitleBar } from '@/components/app/TitleBar';
import { ChatView } from '@/components/chat/ChatView';
import { Sidebar } from '@/components/chat/Sidebar';

export default function App() {
  return (
    <div className="flex h-screen flex-col">
      <TitleBar title="EnsoCode" />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <ChatView />
      </div>
    </div>
  );
}
