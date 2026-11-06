import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {Workspace} from '../../src/features/workspace/Workspace';
import {useStore} from '../../src/stores/useAppStore';
const old=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollTo');
afterEach(()=>{cleanup();useStore.getState().newProject();if(old)Object.defineProperty(HTMLElement.prototype,'scrollTo',old);else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;});
it('renders local and restored transcript as text, including HTML-shaped user and assistant data',()=>{
 Object.defineProperty(HTMLElement.prototype,'scrollTo',{value:vi.fn(),configurable:true});useStore.getState().newProject();
 const user='<img src=x onerror="alert(1)">',assistant='<script>untrusted()</script>';
 useStore.setState({messages:[{id:'a',role:'user',text:user,done:true},{id:'b',role:'assistant',text:assistant,done:true}]});
 const view=render(<Workspace/>);expect(screen.getByText(user)).toBeInTheDocument();expect(screen.getByText(assistant)).toBeInTheDocument();
 expect(view.container.querySelector('.content img,.content script')).toBeNull();expect(screen.queryByText(/200k ctx/)).not.toBeInTheDocument();
});
